"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CYBER_MODELS, getDefaultModelId } from "@/lib/models";
import { getDeviceId } from "@/lib/deviceId";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  updated_at: string;
}

function AssistantContent({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="typing-indicator" aria-label="Assistant is typing">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </div>
  );
}

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `msg-${Date.now()}-${idCounter}`;
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return "";
  }
}

export default function ChatPage() {
  const [deviceId, setDeviceId] = useState<string>("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [selectedModelId, setSelectedModelId] = useState<string>(
    getDefaultModelId()
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isWaitingFirstToken, setIsWaitingFirstToken] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const id = getDeviceId();
    setDeviceId(id);
  }, []);

  const refreshConversations = useCallback(async (currentDeviceId: string) => {
    if (!currentDeviceId) return;
    try {
      const response = await fetch("/api/conversations", {
        method: "GET",
        headers: { "x-device-id": currentDeviceId },
      });
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data?.conversations)) {
        setConversations(data.conversations);
      }
    } catch {
      // Ignore failures to load conversation history; chat still works.
    }
  }, []);

  useEffect(() => {
    if (!deviceId) return;
    refreshConversations(deviceId);
  }, [deviceId, refreshConversations]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isWaitingFirstToken]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  function handleNewChat() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setIsLoading(false);
    setIsWaitingFirstToken(false);
  }

  async function handleSelectConversation(conversation: Conversation) {
    if (!deviceId || conversation.id === activeConversationId) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    setActiveConversationId(conversation.id);
    setSelectedModelId(conversation.model || getDefaultModelId());
    setInput("");
    setIsLoading(false);
    setIsWaitingFirstToken(false);
    setMessages([]);

    try {
      const response = await fetch(
        `/api/conversations/${conversation.id}`,
        {
          method: "GET",
          headers: { "x-device-id": deviceId },
        }
      );
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data?.messages)) {
        const loaded: ChatMessage[] = data.messages.map(
          (m: { role: string; content: string }) => ({
            id: nextId(),
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })
        );
        setMessages(loaded);
      }
    } catch {
      // Ignore load failures; user can retry by clicking again.
    }
  }

  async function handleDeleteConversation(
    e: React.MouseEvent,
    conversationId: string
  ) {
    e.stopPropagation();
    if (!deviceId) return;

    const confirmed = window.confirm(
      "Delete this conversation? This cannot be undone."
    );
    if (!confirmed) return;

    try {
      await fetch(`/api/conversations/${conversationId}`, {
        method: "DELETE",
        headers: { "x-device-id": deviceId },
      });
    } catch {
      // Even if the request fails, still remove it locally below for now.
    }

    setConversations((prev) => prev.filter((c) => c.id !== conversationId));

    if (activeConversationId === conversationId) {
      handleNewChat();
    }
  }

  function appendErrorMessage() {
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: "assistant",
        content: "Something went wrong. Please try again.",
      },
    ]);
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    let conversationId = activeConversationId;

    if (!conversationId && deviceId) {
      try {
        const createResponse = await fetch("/api/conversations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-device-id": deviceId,
          },
          body: JSON.stringify({ model: selectedModelId }),
        });
        if (createResponse.ok) {
          const data = await createResponse.json();
          if (data?.conversation?.id) {
            conversationId = data.conversation.id;
            setActiveConversationId(conversationId);
            setConversations((prev) => [
              {
                id: data.conversation.id,
                title: data.conversation.title || "New chat",
                model: data.conversation.model || selectedModelId,
                updated_at:
                  data.conversation.updated_at || new Date().toISOString(),
              },
              ...prev,
            ]);
          }
        }
      } catch {
        // If conversation creation fails, continue without persistence.
      }
    }

    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: trimmed,
    };

    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setIsLoading(true);
    setIsWaitingFirstToken(true);

    const assistantId = nextId();
    let assistantContent = "";
    let assistantAdded = false;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": deviceId,
        },
        body: JSON.stringify({
          model: selectedModelId,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          conversationId,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        appendErrorMessage();
        setIsLoading(false);
        setIsWaitingFirstToken(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed?.error) {
              continue;
            }
            const delta: string | undefined = parsed?.content;
            if (delta) {
              if (!assistantAdded) {
                assistantAdded = true;
                setIsWaitingFirstToken(false);
                setMessages((prev) => [
                  ...prev,
                  { id: assistantId, role: "assistant", content: delta },
                ]);
                assistantContent = delta;
              } else {
                assistantContent += delta;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: assistantContent }
                      : m
                  )
                );
              }
            }
          } catch {
            // Ignore malformed SSE chunks
          }
        }
      }

      if (!assistantAdded) {
        appendErrorMessage();
      } else if (deviceId) {
        refreshConversations(deviceId);
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        appendErrorMessage();
      }
    } finally {
      setIsLoading(false);
      setIsWaitingFirstToken(false);
      abortControllerRef.current = null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-shell-with-sidebar">
      {sidebarOpen && (
        <aside className="sidebar">
          <div className="sidebar-header">
            <button
              type="button"
              className="sidebar-new-chat-btn"
              onClick={handleNewChat}
            >
              + New chat
            </button>
          </div>
          <div className="sidebar-conversation-list">
            {conversations.length === 0 && (
              <div className="sidebar-empty">No conversations yet.</div>
            )}
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`sidebar-conversation-item${
                  conversation.id === activeConversationId ? " active" : ""
                }`}
                onClick={() => handleSelectConversation(conversation)}
              >
                <div className="sidebar-conversation-title">
                  {conversation.title || "New chat"}
                </div>
                <div className="sidebar-conversation-date">
                  {formatDate(conversation.updated_at)}
                </div>
                <button
                  type="button"
                  className="sidebar-delete-btn"
                  aria-label="Delete conversation"
                  onClick={(e) => handleDeleteConversation(e, conversation.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </aside>
      )}

      <div className="chat-shell">
        <header className="chat-header">
          <button
            type="button"
            className="sidebar-toggle-btn"
            aria-label="Toggle sidebar"
            onClick={() => setSidebarOpen((prev) => !prev)}
          >
            ☰
          </button>
          <div className="chat-header-title">Cyber Chat</div>
          <div className="chat-header-controls">
            <select
              className="model-select"
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              disabled={isLoading}
              aria-label="Select model"
            >
              {CYBER_MODELS.map((m) => (
                <option key={m.id} value={m.id} title={m.description}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="new-chat-btn"
              onClick={handleNewChat}
              disabled={isLoading && messages.length === 0}
            >
              New chat
            </button>
          </div>
        </header>

        <main className="chat-messages">
          <div className="chat-messages-inner">
            {messages.length === 0 && !isWaitingFirstToken && (
              <div className="empty-state">
                Start a conversation with{" "}
                {CYBER_MODELS.find((m) => m.id === selectedModelId)?.label}.
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={`bubble-row ${m.role}`}>
                <div className={`bubble ${m.role}`}>
                  {m.role === "assistant" ? (
                    <AssistantContent content={m.content} />
                  ) : (
                    <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>
                  )}
                </div>
              </div>
            ))}

            {isWaitingFirstToken && (
              <div className="bubble-row assistant">
                <div className="bubble assistant">
                  <TypingIndicator />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        <footer className="chat-input-bar">
          <div className="chat-input-inner">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              placeholder="Message Cyber Chat..."
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
            />
            <button
              type="button"
              className="send-btn"
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
            >
              Send
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}