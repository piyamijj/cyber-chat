const DEVICE_ID_STORAGE_KEY = "cyber-chat-device-id";

function generateUuidV4Fallback(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return generateUuidV4Fallback();
}

export function getDeviceId(): string {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const newId = generateId();
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, newId);
    return newId;
  } catch {
    return generateId();
  }
}