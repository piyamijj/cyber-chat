import { NextRequest } from "next/server";
import OpenAI from "openai";
import { resolveModel } from "@/lib/models";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { appendMessage, renameConversationIfDefault } from "@/lib/db";
import { streamGeminiChat } from "@/lib/gemini";
import { streamGroqChat } from "@/lib/groq";
import { lookupCache, storeCache } from "@/lib/cache";

export const runtime = "nodejs";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  imageBase64?: string;
  imageMimeType?: string;
}

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  conversationId?: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || "New chat";
}

function sseEncode(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function sseDone(): Uint8Array {
  return new TextEncoder().encode(`data: [DONE]\n\n`);
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;

  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { model, messages, conversationId } = body || {};

  if (!model || typeof model !== "string") {
    return new Response(
      JSON.stringify({ error: "A valid model must be specified." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "A non-empty messages array is required." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const deviceId = req.headers.get("x-device-id")?.trim() || null;
  const hasValidConversation =
    !!deviceId &&
    typeof conversationId === "string" &&
    UUID_REGEX.test(conversationId);

  let cyberModel;
  try {
    cyberModel = resolveModel(model);
  } catch {
    return new Response(
      JSON.stringify({ error: "Unknown model selection." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Always enforce our own system prompt server-side: drop any system
  // messages the client may have sent, then prepend the fixed one.
  // This keeps identity/formatting rules non-overridable from the UI.
  const sanitizedMessages = messages.filter((m) => m.role !== "system");
  const finalMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sanitizedMessages,
  ];

  // Cache is only safe for the FIRST turn of a conversation with no
  // image attached: a cached answer has no memory of prior context, so
  // using it mid-conversation (or for an image-dependent question)
  // could silently ignore what the user actually asked. Multi-turn and
  // image messages always go to the model live.
  const lastUserMsg = sanitizedMessages[sanitizedMessages.length - 1];
  const isCacheEligible =
    sanitizedMessages.length === 1 &&
    lastUserMsg?.role === "user" &&
    !lastUserMsg?.imageBase64 &&
    typeof lastUserMsg?.content === "string" &&
    lastUserMsg.content.trim().length > 0;

  if (isCacheEligible) {
    const cacheHit = await lookupCache(lastUserMsg.content, model);
    if (cacheHit) {
      if (hasValidConversation) {
        try {
          await appendMessage(
            conversationId as string,
            deviceId as string,
            "user",
            lastUserMsg.content
          );
          await appendMessage(
            conversationId as string,
            deviceId as string,
            "assistant",
            cacheHit.answer
          );
          await renameConversationIfDefault(
            conversationId as string,
            deviceId as string,
            deriveTitle(lastUserMsg.content)
          );
        } catch {
          // Ignore persistence failures; cached answer still returns.
        }
      }

      const cachedStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            sseEncode({ content: cacheHit.answer, cached: true, cacheSource: cacheHit.source })
          );
          controller.enqueue(sseDone());
          controller.close();
        },
      });

      return new Response(cachedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }
  }

  // Best-effort persistence of the latest user message. Never blocks or
  // fails the chat response if the DB is unavailable.
  if (hasValidConversation) {
    const lastUserMessage = [...sanitizedMessages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMessage) {
      try {
        await appendMessage(
          conversationId as string,
          deviceId as string,
          "user",
          lastUserMessage.content
        );
        await renameConversationIfDefault(
          conversationId as string,
          deviceId as string,
          deriveTitle(lastUserMessage.content)
        );
      } catch {
        // Ignore persistence failures; chat still works without history.
      }
    }
  }

  // Resolve provider + credentials, and build an async generator of
  // plain-text deltas regardless of which upstream provider is used, so
  // the streaming/persistence logic below stays provider-agnostic.
  let textDeltaGenerator: AsyncGenerator<string, void, unknown>;

  if (cyberModel.provider === "gemini") {
    const geminiMessages = sanitizedMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        imageBase64: m.imageBase64,
        imageMimeType: m.imageMimeType,
      }));

    try {
      textDeltaGenerator = streamGeminiChat(
        cyberModel.providerModel,
        SYSTEM_PROMPT,
        geminiMessages
      );
    } catch {
      return new Response(
        JSON.stringify({ error: "Server is not configured correctly." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  } else if (cyberModel.provider === "groq-expert") {
    const keyPool = [
      process.env.GROQ_API_KEY_EXPERT,
      process.env.GROQ_API_KEY_EXPERT_2,
    ].filter((k): k is string => typeof k === "string" && k.length > 0);

    if (keyPool.length === 0) {
      return new Response(
        JSON.stringify({ error: "Server is not configured correctly." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      textDeltaGenerator = streamGroqChat(
        keyPool,
        cyberModel.providerModel,
        finalMessages
      );
    } catch (err: any) {
      const status =
        typeof err?.status === "number" &&
        err.status >= 400 &&
        err.status < 600
          ? err.status
          : 502;
      return new Response(
        JSON.stringify({ error: "Upstream model provider request failed." }),
        { status, headers: { "Content-Type": "application/json" } }
      );
    }
  } else {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server is not configured correctly." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const client = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });

    let groqStream;
    try {
      groqStream = await client.chat.completions.create({
        model: cyberModel.providerModel,
        messages: finalMessages,
        stream: true,
      });
    } catch (err: any) {
      const status =
        typeof err?.status === "number" &&
        err.status >= 400 &&
        err.status < 600
          ? err.status
          : 502;
      return new Response(
        JSON.stringify({ error: "Upstream model provider request failed." }),
        { status, headers: { "Content-Type": "application/json" } }
      );
    }

    textDeltaGenerator = (async function* () {
      for await (const chunk of groqStream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    })();
  }

  const encoderStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullContent = "";
      try {
        for await (const delta of textDeltaGenerator) {
          fullContent += delta;
          controller.enqueue(sseEncode({ content: delta }));
        }
        controller.enqueue(sseDone());
      } catch {
        controller.enqueue(
          sseEncode({ error: "The response stream was interrupted." })
        );
      } finally {
        if (hasValidConversation && fullContent) {
          try {
            await appendMessage(
              conversationId as string,
              deviceId as string,
              "assistant",
              fullContent
            );
          } catch {
            // Ignore persistence failures; chat still works without history.
          }
        }
        if (isCacheEligible && fullContent) {
          // Fire-and-forget: don't let cache writing delay closing the
          // stream the user is already reading.
          storeCache(lastUserMsg.content, model, fullContent).catch(() => {});
        }
        controller.close();
      }
    },
  });

  return new Response(encoderStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}