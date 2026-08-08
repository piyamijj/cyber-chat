import { NextRequest } from "next/server";
import { listConversations, createConversation } from "@/lib/db";
import { CYBER_MODELS, getDefaultModelId } from "@/lib/models";

export const runtime = "nodejs";

function getDeviceId(req: NextRequest): string | null {
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId || typeof deviceId !== "string" || deviceId.trim() === "") {
    return null;
  }
  return deviceId.trim();
}

export async function GET(req: NextRequest) {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return new Response(JSON.stringify({ error: "Missing device id." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const conversations = await listConversations(deviceId);
    return new Response(JSON.stringify({ conversations }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Failed to load conversations." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function POST(req: NextRequest) {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return new Response(JSON.stringify({ error: "Missing device id." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { model?: string } = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let model = body?.model;
  if (model !== undefined) {
    const isKnown = CYBER_MODELS.some((m) => m.id === model);
    if (!isKnown) {
      return new Response(JSON.stringify({ error: "Unknown model." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    model = getDefaultModelId();
  }

  try {
    const conversation = await createConversation(deviceId, model);
    return new Response(JSON.stringify({ conversation }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Failed to create conversation." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}