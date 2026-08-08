import { NextRequest } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let formData: FormData;

  try {
    formData = await req.formData();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const audio = formData.get("audio");

  if (!audio || !(audio instanceof Blob)) {
    return new Response(
      JSON.stringify({ error: "No audio file provided." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (audio.size > MAX_AUDIO_BYTES) {
    return new Response(
      JSON.stringify({ error: "Audio file too large." }),
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

  try {
    const fileName =
      audio instanceof File && audio.name ? audio.name : "audio.webm";
    const uploadableFile = new File([audio], fileName, {
      type: audio.type || "audio/webm",
    });

    const transcription = await client.audio.transcriptions.create({
      file: uploadableFile,
      model: "whisper-large-v3",
      response_format: "json",
      // Force Turkish: without this, Whisper auto-detects the spoken
      // language and short/unclear clips can get misdetected as a
      // different language entirely, producing a nonsensical transcript
      // in the wrong language instead of a bad-but-Turkish guess.
      language: "tr",
    });

    return new Response(JSON.stringify({ text: transcription.text }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Transcription failed. Please try again." }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}