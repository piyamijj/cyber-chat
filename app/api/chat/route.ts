import { NextRequest } from "next/server";
import OpenAI from "openai";
import { resolveGroqModel } from "@/lib/models";

export const runtime = "nodejs";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
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

  const { model, messages } = body || {};

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

  let stream;
  try {
    stream = await client.chat.completions.create({
      model: groqModel,
      messages,
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
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
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