export interface GeminiChatMessagePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64-encoded, no data: prefix
  };
}

export interface GeminiChatMessage {
  role: "user" | "assistant";
  content: string;
  imageBase64?: string;
  imageMimeType?: string;
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function isQuotaOrRateLimitError(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  if (status === 400 || status === 403) {
    const lower = bodyText.toLowerCase();
    return (
      lower.includes("quota") ||
      lower.includes("rate limit") ||
      lower.includes("rate_limit") ||
      lower.includes("resource_exhausted") ||
      lower.includes("resource exhausted")
    );
  }
  return false;
}

function toGeminiContents(
  systemPrompt: string,
  messages: GeminiChatMessage[]
): { systemInstruction: { parts: GeminiChatMessagePart[] }; contents: unknown[] } {
  const contents = messages.map((m) => {
    const parts: GeminiChatMessagePart[] = [];
    if (m.content) {
      parts.push({ text: m.content });
    }
    if (m.imageBase64 && m.imageMimeType) {
      parts.push({
        inlineData: {
          mimeType: m.imageMimeType,
          data: m.imageBase64,
        },
      });
    }
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts,
    };
  });

  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
  };
}

async function requestGeminiStream(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: GeminiChatMessage[]
): Promise<Response> {
  const { systemInstruction, contents } = toGeminiContents(
    systemPrompt,
    messages
  );

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction,
      contents,
    }),
  });

  return response;
}

/**
 * Streams a Gemini chat completion as an async generator of plain text
 * deltas, so callers can treat it the same way as a Groq/OpenAI stream.
 *
 * Implements failover: tries GEMINI_API_KEY_1 first. If that request
 * fails with a rate-limit/quota-style error, automatically retries the
 * exact same request with GEMINI_API_KEY_2 before giving up. Any other
 * kind of failure (bad request, network error, etc.) is NOT retried
 * with the second key, since retrying would not help and could double
 * up on a request that failed for an unrelated reason.
 */
export async function* streamGeminiChat(
  model: string,
  systemPrompt: string,
  messages: GeminiChatMessage[]
): AsyncGenerator<string, void, unknown> {
  const key1 = process.env.GEMINI_API_KEY_1;
  const key2 = process.env.GEMINI_API_KEY_2;

  if (!key1 && !key2) {
    throw new Error("No Gemini API key configured.");
  }

  const keysToTry = [key1, key2].filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );

  let lastError: Error | null = null;

  for (let i = 0; i < keysToTry.length; i++) {
    const key = keysToTry[i];
    const isLastKey = i === keysToTry.length - 1;

    let response: Response;
    try {
      response = await requestGeminiStream(key, model, systemPrompt, messages);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (isLastKey) throw lastError;
      continue;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const shouldFailover = isQuotaOrRateLimitError(
        response.status,
        bodyText
      );

      if (shouldFailover && !isLastKey) {
        // Try the next key.
        continue;
      }

      throw new Error(
        `Gemini request failed (status ${response.status}): ${bodyText.slice(
          0,
          500
        )}`
      );
    }

    if (!response.body) {
      throw new Error("Gemini response had no body.");
    }

    // Successfully got a streaming response on this key — consume it
    // and yield text deltas. From this point on we no longer failover
    // (the connection is already established and producing output).
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          try {
            const parsed: GeminiStreamChunk = JSON.parse(jsonStr);
            const text = parsed.candidates?.[0]?.content?.parts
              ?.map((p) => p.text || "")
              .join("");
            if (text) {
              yield text;
            }
          } catch {
            // Ignore lines that aren't valid JSON (keep-alives, etc.)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return;
  }

  if (lastError) throw lastError;
  throw new Error("Gemini request failed for an unknown reason.");
}