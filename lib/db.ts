import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL || "";

export const sql = neon(connectionString);

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
      // pgvector: powers the semantic cache (Phase B) — embeddings are
      // stored as a `vector` column and matched with cosine distance.
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;

      await sql`
        CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          device_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'New chat',
          model TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages (conversation_id, created_at)
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS idx_conversations_device_updated
        ON conversations (device_id, updated_at DESC)
      `;

      // Response cache (Phase A: exact match via normalized_question,
      // Phase B: semantic match via embedding). One row per
      // (question, model) pair — the same question can be cached
      // separately per model, since different models may answer
      // differently.
      await sql`
        CREATE TABLE IF NOT EXISTS response_cache (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          model TEXT NOT NULL,
          normalized_question TEXT NOT NULL,
          original_question TEXT NOT NULL,
          answer TEXT NOT NULL,
          embedding vector(768),
          hit_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_response_cache_exact
        ON response_cache (model, normalized_question)
      `;

      // HNSW index for fast approximate cosine-similarity search
      // (Phase B semantic lookup).
      await sql`
        CREATE INDEX IF NOT EXISTS idx_response_cache_embedding
        ON response_cache USING hnsw (embedding vector_cosine_ops)
      `;
    })();
  }
  return schemaReady;
}

export interface ConversationRow {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export async function listConversations(
  deviceId: string
): Promise<ConversationRow[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT id, title, model, created_at, updated_at
    FROM conversations
    WHERE device_id = ${deviceId}
    ORDER BY updated_at DESC
  `;
  return rows as unknown as ConversationRow[];
}

export async function createConversation(
  deviceId: string,
  model: string,
  title: string = "New chat"
): Promise<ConversationRow> {
  await ensureSchema();
  const rows = await sql`
    INSERT INTO conversations (device_id, model, title)
    VALUES (${deviceId}, ${model}, ${title})
    RETURNING id, title, model, created_at, updated_at
  `;
  return rows[0] as unknown as ConversationRow;
}

export async function getConversationMessages(
  conversationId: string,
  deviceId: string
): Promise<MessageRow[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
    FROM messages m
    INNER JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ${conversationId}
      AND c.device_id = ${deviceId}
    ORDER BY m.created_at ASC
  `;
  return rows as unknown as MessageRow[];
}

export async function appendMessage(
  conversationId: string,
  deviceId: string,
  role: string,
  content: string
): Promise<MessageRow> {
  await ensureSchema();

  const owned = await sql`
    SELECT id FROM conversations
    WHERE id = ${conversationId} AND device_id = ${deviceId}
  `;
  if (owned.length === 0) {
    throw new Error("Conversation not found or not owned by this device.");
  }

  const rows = await sql`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (${conversationId}, ${role}, ${content})
    RETURNING id, conversation_id, role, content, created_at
  `;

  await sql`
    UPDATE conversations
    SET updated_at = now()
    WHERE id = ${conversationId} AND device_id = ${deviceId}
  `;

  return rows[0] as unknown as MessageRow;
}

export async function renameConversationIfDefault(
  conversationId: string,
  deviceId: string,
  newTitle: string
): Promise<void> {
  await ensureSchema();
  await sql`
    UPDATE conversations
    SET title = ${newTitle}
    WHERE id = ${conversationId}
      AND device_id = ${deviceId}
      AND title = 'New chat'
  `;
}

export async function deleteConversation(
  conversationId: string,
  deviceId: string
): Promise<void> {
  await ensureSchema();
  await sql`
    DELETE FROM conversations
    WHERE id = ${conversationId} AND device_id = ${deviceId}
  `;
}