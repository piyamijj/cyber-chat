"use client";

import { useEffect, useRef, useState } from "react";
import { CYBER_MODELS, getDefaultModelId } from "@/lib/models";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function renderContent(content: string) {
  const parts = content.split(/```/g);
  return parts.map((part, idx) => {
    if (idx % 2 === 1) {
      const lines = part.split("\n");
      const maybeLang = lines[0]?.trim();
      const code =
        maybeLang && lines.length > 1 ? lines.slice(1).join("\n") : part;
      return (
        <pre key={idx}>
          <code>{code.replace(/\n$/, "")}</code>
        </pre>
      );
    }
    return (
      <span key={idx} style={{ whiteSpace: "pre-wrap" }}>
        {part}
      </span>
    );
  });
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

export default function ChatPage() {
  const [selectedModelId, setSelectedModelId] = useState<string>(
    getDefaultModelId()
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isWaitingFirstToken, setIsWaitingFirstToken] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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
    setMessages([]);
    setInput("");
    setIsLoading(false);
    setIsWaitingFirstToken(false);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModelId,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
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
            const delta: string | undefined =
              parsed?.choices?.[0]?.delta?.content;
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
    <div className="chat-shell">
      <header className="chat-header">
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
              Start a conversation with {
                CYBER_MODELS.find((m) => m.id === selectedModelId)?.label
              }.
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className={`bubble ${m.role}`}>{renderContent(m.content)}</div>
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
  );
}