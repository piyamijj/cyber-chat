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
  sendContent?: string;
  attachedFileName?: string;
  imageBase64?: string;
  imageMimeType?: string;
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
    <div className="typing-indicator" aria-label="Asistan yazıyor">
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isExtractingFile, setIsExtractingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [attachedFile, setAttachedFile] = useState<{
    fileName: string;
    text: string;
    imageBase64?: string;
    imageMimeType?: string;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = getDeviceId();
    setDeviceId(id);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSidebarOpen(window.innerWidth > 768);
  }, []);

  function isMobileViewport(): boolean {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= 768;
  }

  function closeSidebarOnMobile() {
    if (isMobileViewport()) {
      setSidebarOpen(false);
    }
  }

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
    closeSidebarOnMobile();
  }

  async function handleSelectConversation(conversation: Conversation) {
    if (!deviceId || conversation.id === activeConversationId) {
      closeSidebarOnMobile();
      return;
    }

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
    closeSidebarOnMobile();

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
      "Bu sohbeti sil? Bu işlem geri alınamaz."
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
        content: "Bir sorun oluştu. Lütfen tekrar deneyin.",
      },
    ]);
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (isLoading) return;
    // Allow sending with no typed text only if an image is attached
    // (e.g. "what's in this picture?" with just the image itself).
    if (!trimmed && !attachedFile?.imageBase64) return;

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
                title: data.conversation.title || "Yeni sohbet",
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

    const fileToSend = attachedFile;
    const isImageAttachment = !!fileToSend?.imageBase64;
    const sendContent = fileToSend
      ? isImageAttachment
        ? trimmed || "Bu görseli analiz et."
        : `${trimmed}\n\n[Attached file: ${fileToSend.fileName}]\n---\n${fileToSend.text}\n---`
      : trimmed;

    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: trimmed || (isImageAttachment ? "🖼 (görsel)" : ""),
      sendContent,
      attachedFileName: fileToSend?.fileName,
      imageBase64: fileToSend?.imageBase64,
      imageMimeType: fileToSend?.imageMimeType,
    };

    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setAttachedFile(null);
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
          messages: history.map((m) => ({
            role: m.role,
            content: m.sendContent || m.content,
            imageBase64: m.imageBase64,
            imageMimeType: m.imageMimeType,
          })),
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

  async function handleStartRecording() {
    if (isRecording || isTranscribing || isLoading) return;

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof MediaRecorder === "undefined"
    ) {
      appendErrorMessage();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      mediaStreamRef.current = stream;
      recordedChunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;

        const blob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        recordedChunksRef.current = [];

        if (blob.size === 0) {
          return;
        }

        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append("audio", blob, "recording.webm");

          const response = await fetch("/api/transcribe", {
            method: "POST",
            body: formData,
          });

          if (response.ok) {
            const data = await response.json();
            if (data?.text) {
              setInput((prev) =>
                prev ? `${prev} ${data.text}` : data.text
              );
            }
          }
        } catch {
          // Silently ignore transcription failures; user can type instead.
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch {
      // Microphone permission denied or unavailable; ignore silently.
    }
  }

  function handleStopRecording() {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setIsRecording(false);
  }

  function handleMicClick() {
    if (isRecording) {
      handleStopRecording();
    } else {
      handleStartRecording();
    }
  }

  function handleFilePick() {
    fileInputRef.current?.click();
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // result is a data URL like "data:image/png;base64,AAAA..."
        const base64 = result.split(",")[1] || "";
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setFileError(null);

    const currentModel = CYBER_MODELS.find((m) => m.id === selectedModelId);
    const isImage = file.type.startsWith("image/");

    if (isImage) {
      if (!currentModel?.supportsImages) {
        setFileError(
          "Görsel yükleme sadece cyber vision modelinde desteklenir. Lütfen önce modeli değiştirin."
        );
        return;
      }
      try {
        const base64 = await fileToBase64(file);
        setAttachedFile({
          fileName: file.name,
          text: "",
          imageBase64: base64,
          imageMimeType: file.type,
        });
      } catch {
        setFileError("Görsel okunamadı. Lütfen başka bir görsel deneyin.");
      }
      return;
    }

    setIsExtractingFile(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/extract-file", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (response.ok && data?.text) {
        setFileError(null);
        setAttachedFile({ fileName: data.fileName || file.name, text: data.text });
      } else {
        setFileError(
          data?.error || "Dosya okunamadı. Lütfen başka bir dosya deneyin."
        );
      }
    } catch {
      setFileError("Dosya okunamadı. Lütfen başka bir dosya deneyin.");
    } finally {
      setIsExtractingFile(false);
    }
  }

  function handleRemoveAttachedFile() {
    setAttachedFile(null);
  }

  function handleDismissFileError() {
    setFileError(null);
  }

  return (
    <div className="chat-shell-with-sidebar">
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {sidebarOpen && (
        <aside className="sidebar">
          <div className="sidebar-header">
            <button
              type="button"
              className="sidebar-new-chat-btn"
              onClick={handleNewChat}
            >
              + Yeni sohbet
            </button>
            <button
              type="button"
              className="sidebar-close-btn"
              aria-label="Kenar çubuğunu kapat"
              onClick={() => setSidebarOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="sidebar-conversation-list">
            {conversations.length === 0 && (
              <div className="sidebar-empty">Henüz sohbet yok.</div>
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
                  {conversation.title || "Yeni sohbet"}
                </div>
                <div className="sidebar-conversation-date">
                  {formatDate(conversation.updated_at)}
                </div>
                <button
                  type="button"
                  className="sidebar-delete-btn"
                  aria-label="Sohbeti sil"
                  title="Sohbeti sil"
                  onClick={(e) => handleDeleteConversation(e, conversation.id)}
                >
                  🗑
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
            aria-label="Kenar çubuğunu aç/kapat"
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
              aria-label="Model seç"
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
              Yeni sohbet
            </button>
          </div>
        </header>

        <main className="chat-messages">
          <div className="chat-messages-inner">
            {messages.length === 0 && !isWaitingFirstToken && (
              <div className="empty-state">
                {CYBER_MODELS.find((m) => m.id === selectedModelId)?.label}{" "}
                ile bir sohbet başlat.
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className={`bubble-row ${m.role}`}>
                <div className={`bubble ${m.role}`}>
                  {m.attachedFileName && (
                    <div className="attached-file-chip">
                      {m.imageBase64 ? "🖼" : "📎"} {m.attachedFileName}
                    </div>
                  )}
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
          {fileError && (
            <div className="file-error-banner">
              <span className="file-error-text">⚠ {fileError}</span>
              <button
                type="button"
                className="file-error-dismiss-btn"
                onClick={handleDismissFileError}
                aria-label="Uyarıyı kapat"
              >
                ✕
              </button>
            </div>
          )}
          {attachedFile && (
            <div className="attached-file-preview">
              <span className="attached-file-preview-name">
                {attachedFile.imageBase64 ? "🖼" : "📎"} {attachedFile.fileName}
              </span>
              <button
                type="button"
                className="attached-file-remove-btn"
                onClick={handleRemoveAttachedFile}
                aria-label="Eklenen dosyayı kaldır"
              >
                ✕
              </button>
            </div>
          )}
          <div className="chat-input-inner">
            <input
              ref={fileInputRef}
              type="file"
              accept={
                CYBER_MODELS.find((m) => m.id === selectedModelId)
                  ?.supportsImages
                  ? ".txt,.md,.markdown,.csv,.json,.log,.pdf,.docx,.xlsx,.xls,.pptx,.html,.htm,.js,.jsx,.ts,.tsx,.css,.scss,.py,.xml,.yaml,.yml,.sh,.sql,.java,.c,.cpp,.h,.hpp,.go,.rb,.php,.rs,.swift,.kt,.env,.ini,.toml,.jpg,.jpeg,.png,.webp"
                  : ".txt,.md,.markdown,.csv,.json,.log,.pdf,.docx,.xlsx,.xls,.pptx,.html,.htm,.js,.jsx,.ts,.tsx,.css,.scss,.py,.xml,.yaml,.yml,.sh,.sql,.java,.c,.cpp,.h,.hpp,.go,.rb,.php,.rs,.swift,.kt,.env,.ini,.toml"
              }
              style={{ display: "none" }}
              onChange={handleFileSelected}
            />
            <button
              type="button"
              className="file-btn"
              onClick={handleFilePick}
              disabled={isLoading || isExtractingFile}
              aria-label="Dosya ekle"
              title="Dosya ekle"
            >
              {isExtractingFile ? "…" : "📎"}
            </button>
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              placeholder={
                isTranscribing
                  ? "Yazıya dökülüyor..."
                  : isRecording
                  ? "Kaydediliyor... durdurmak için mikrofona tıklayın"
                  : isExtractingFile
                  ? "Dosya okunuyor..."
                  : "Cyber Chat'e mesaj yaz..."
              }
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading || isTranscribing}
            />
            <button
              type="button"
              className={`mic-btn${isRecording ? " recording" : ""}`}
              onClick={handleMicClick}
              disabled={isLoading || isTranscribing}
              aria-label={isRecording ? "Kaydı durdur" : "Sesli girişi başlat"}
              title={isRecording ? "Kaydı durdur" : "Sesli girişi başlat"}
            >
              {isTranscribing ? "…" : isRecording ? "■" : "🎤"}
            </button>
            <button
              type="button"
              className="send-btn"
              onClick={handleSend}
              disabled={isLoading || isTranscribing || !input.trim()}
            >
              Gönder
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}