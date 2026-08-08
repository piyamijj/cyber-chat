import OpenAI from "openai";

export interface GroqChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function isQuotaOrRateLimitError(err: any): boolean {
  const status = typeof err?.status === "number" ? err.status : undefined;
  if (status === 429) return true;
  if (status === 400 || status === 403) {
    const bodyText = JSON.stringify(err?.error || err?.message || "").toLowerCase();
    return (
      bodyText.includes("quota") ||
      bodyText.includes("rate limit") ||
      bodyText.includes("rate_limit") ||
      bodyText.includes("resource_exhausted") ||
      bodyText.includes("resource exhausted")
    );
  }
  return false;
}

/**
 * Streams a Groq chat completion as an async generator of plain text
 * deltas, trying each key in `keyPool` in order. If a request fails
 * with a rate-limit/quota-style error, automatically retries the exact
 * same request with the next key before giving up. Any other kind of
 * failure (bad request, network error, etc.) is NOT retried with the
 * next key, since retrying would not help and could double up on a
 * request that failed for an unrelated reason.
 *
 * Used by the 'cyber expert' model, which has two Groq keys
 * (GROQ_API_KEY_EXPERT, GROQ_API_KEY_EXPERT_2) for failover headroom.
 */
export async function* streamGroqChat(
  keyPool: string[],
  model: string,
  messages: GroqChatMessage[]
): AsyncGenerator<string, void, unknown> {
  const keysToTry = keyPool.filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );

  if (keysToTry.length === 0) {
    throw new Error("No Groq API key configured.");
  }

  let lastError: Error | null = null;

  for (let i = 0; i < keysToTry.length; i++) {
    const key = keysToTry[i];
    const isLastKey = i === keysToTry.length - 1;

    const client = new OpenAI({
      apiKey: key,
      baseURL: GROQ_BASE_URL,
    });

    let stream;
    try {
      stream = await client.chat.completions.create({
        model,
        messages,
        stream: true,
      });
    } catch (err: any) {
      const shouldFailover = isQuotaOrRateLimitError(err);
      if (shouldFailover && !isLastKey) {
        continue;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      throw lastError;
    }

    // Successfully started a streaming response on this key — consume
    // it and yield text deltas. From this point on we no longer
    // failover (the connection is already established and producing
    // output).
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
    return;
  }

  if (lastError) throw lastError;
  throw new Error("Groq request failed for an unknown reason.");
}