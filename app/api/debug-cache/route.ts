import { NextRequest } from "next/server";
import { sql, ensureSchema } from "@/lib/db";
import { embedText } from "@/lib/gemini";
import { normalizeQuestion } from "@/lib/cache";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { question?: string; model?: string };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const question = body?.question;
  const model = body?.model;

  if (!question || typeof question !== "string" || !model || typeof model !== "string") {
    return new Response(
      JSON.stringify({ error: "Both 'question' and 'model' are required." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const result: Record<string, unknown> = {
    question,
    model,
    normalized: normalizeQuestion(question),
  };

  try {
    await ensureSchema();
    result.schemaReady = true;
  } catch (err) {
    result.schemaError = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const exactRows = await sql`
      SELECT id, normalized_question, answer
      FROM response_cache
      WHERE model = ${model} AND normalized_question = ${result.normalized as string}
      LIMIT 1
    `;
    result.exactMatchFound = exactRows.length > 0;
  } catch (err) {
    result.exactMatchError = err instanceof Error ? err.message : String(err);
  }

  let embedding: number[] | null = null;
  try {
    embedding = await embedText(question);
    result.embeddingGenerated = true;
    result.embeddingLength = embedding.length;
  } catch (err) {
    result.embeddingError = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const vectorLiteral = `[${embedding.join(",")}]`;
    const semanticRows = await sql`
      SELECT id, normalized_question, original_question,
             1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM response_cache
      WHERE model = ${model} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT 5
    `;
    result.semanticCandidates = semanticRows;
    result.similarityThreshold = 0.93;
  } catch (err) {
    result.semanticQueryError = err instanceof Error ? err.message : String(err);
  }

  try {
    const countRows = await sql`
      SELECT COUNT(*)::int AS count
      FROM response_cache
      WHERE model = ${model}
    `;
    result.totalCachedRowsForModel = (countRows[0] as unknown as { count: number })
      ?.count;
  } catch (err) {
    result.countError = err instanceof Error ? err.message : String(err);
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}