import { NextRequest } from "next/server";
import { getConversationMessages, deleteConversation } from "@/lib/db";

export const runtime = "nodejs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getDeviceId(req: NextRequest): string | null {
  const deviceId = req.headers.get("x-device-id");
  if (!deviceId || typeof deviceId !== "string" || deviceId.trim() === "") {
    return null;
  }
  return deviceId.trim();
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return new Response(JSON.stringify({ error: "Missing device id." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { id } = params;
  if (!id || !UUID_REGEX.test(id)) {
    return new Response(
      JSON.stringify({ error: "Invalid conversation id." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const messages = await getConversationMessages(id, deviceId);
    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Failed to load conversation." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return new Response(JSON.stringify({ error: "Missing device id." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { id } = params;
  if (!id || !UUID_REGEX.test(id)) {
    return new Response(
      JSON.stringify({ error: "Invalid conversation id." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    await deleteConversation(id, deviceId);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Failed to delete conversation." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}