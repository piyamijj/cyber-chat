import { NextRequest } from "next/server";
import OpenAI from "openai";
import { resolveGroqModel } from "@/lib/models";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { appendMessage, renameConversationIfDefault } from "@/lib/db";

export const runtime = "nodejs";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

  let groqModel: string;
  try {
    groqModel = resolveGroqModel(model);
  } catch {
    return new Response(
      JSON.stringify({ error: "Unknown model selection." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

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

  // Always enforce our own system prompt server-side: drop any system
  // messages the client may have sent, then prepend the fixed one.
  // This keeps identity/formatting rules non-overridable from the UI.
  const sanitizedMessages = messages.filter((m) => m.role !== "system");
  const finalMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sanitizedMessages,
  ];

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

  let stream;
  try {
    stream = await client.chat.completions.create({
      model: groqModel,
      messages: finalMessages,
      stream: true,
    });
  } catch (err: any) {
    const status =
      typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 502;
    return new Response(
      JSON.stringify({ error: "Upstream model provider request failed." }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoderStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let fullContent = "";
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            controller.enqueue(sseEncode({ content: delta }));
          }
        }
        controller.enqueue(sseDone());
      } catch {
        controller.enqueue(
          sseEncode({ error: "The response stream was interrupted." })
        );
      } finally {
        controller.close();
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