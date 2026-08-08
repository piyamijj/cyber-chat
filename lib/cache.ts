import { sql, ensureSchema } from "./db";
import { embedText } from "./gemini";

const SIMILARITY_THRESHOLD = 0.93;

export interface CacheHit {
  answer: string;
  source: "exact" | "semantic";
  similarity?: number;
}

/**
 * Normalizes a question for exact-match caching: lowercases, trims,
 * collapses internal whitespace, and strips common trailing
 * punctuation so trivially different phrasings of the same question
 * ("Merhaba?" vs "merhaba") still hit the same cache row.
 */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:]+$/g, "")
    .trim();
}

/**
 * Looks up a cached answer for the given question + model. Tries an
 * exact normalized-text match first (cheap, no embedding call). If
 * that misses, falls back to a semantic (embedding cosine similarity)
 * search and returns a hit only if the best match is above
 * SIMILARITY_THRESHOLD.
 *
 * Returns null on any miss or on failure (embedding errors, DB
 * errors) — a cache miss should never block or break the normal chat
 * flow, it should just fall through to calling the model.
 */
export async function lookupCache(
  question: string,
  model: string
): Promise<CacheHit | null> {
  try {
    await ensureSchema();

    const normalized = normalizeQuestion(question);
    if (!normalized) return null;

    const exactRows = await sql`
      SELECT id, answer
      FROM response_cache
      WHERE model = ${model} AND normalized_question = ${normalized}
      LIMIT 1
    `;

    if (exactRows.length > 0) {
      const row = exactRows[0] as unknown as { id: string; answer: string };
      await sql`
        UPDATE response_cache
        SET hit_count = hit_count + 1, last_used_at = now()
        WHERE id = ${row.id}
      `;
      return { answer: row.answer, source: "exact" };
    }

    let embedding: number[];
    try {
      embedding = await embedText(question);
    } catch {
      // Embedding provider unavailable — treat as a cache miss rather
      // than failing the whole request.
      return null;
    }

    const vectorLiteral = `[${embedding.join(",")}]`;

    const semanticRows = await sql`
      SELECT id, answer, 1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM response_cache
      WHERE model = ${model} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT 1
    `;

    if (semanticRows.length > 0) {
      const row = semanticRows[0] as unknown as {
        id: string;
        answer: string;
        similarity: number;
      };
      if (row.similarity >= SIMILARITY_THRESHOLD) {
        await sql`
          UPDATE response_cache
          SET hit_count = hit_count + 1, last_used_at = now()
          WHERE id = ${row.id}
        `;
        return {
          answer: row.answer,
          source: "semantic",
          similarity: row.similarity,
        };
      }
    }

    return null;
  } catch {
    // Any unexpected cache failure must not break normal chat.
    return null;
  }
}

/**
 * Stores a new question/answer pair in the cache for future lookups.
 * Computes and stores the embedding too, so future semantically
 * similar questions can be matched even if the exact text differs.
 *
 * Failures here are swallowed (logged only) — caching is a pure
 * optimization, never allowed to break the response that already
 * succeeded and was already sent to the user.
 */
export async function storeCache(
  question: string,
  model: string,
  answer: string
): Promise<void> {
  try {
    await ensureSchema();

    const normalized = normalizeQuestion(question);
    if (!normalized || !answer) return;

    let embedding: number[] | null = null;
    try {
      embedding = await embedText(question);
    } catch {
      embedding = null;
    }

    const vectorLiteral = embedding ? `[${embedding.join(",")}]` : null;

    await sql`
      INSERT INTO response_cache
        (model, normalized_question, original_question, answer, embedding)
      VALUES
        (${model}, ${normalized}, ${question}, ${answer}, ${vectorLiteral}::vector)
      ON CONFLICT (model, normalized_question)
      DO UPDATE SET
        answer = EXCLUDED.answer,
        embedding = EXCLUDED.embedding,
        last_used_at = now()
    `;
  } catch {
    // Ignore cache write failures; the user's answer was already sent.
  }
}