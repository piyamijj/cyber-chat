export type ModelProvider = "groq" | "groq-expert" | "gemini";

export interface CyberModel {
  id: string;
  label: string;
  provider: ModelProvider;
  // The real upstream model id/name for whichever provider this uses.
  providerModel: string;
  description: string;
  // Whether this model accepts image attachments (vision input).
  supportsImages?: boolean;
}

export const CYBER_MODELS: CyberModel[] = [
  {
    id: "cyber-lite",
    label: "cyber lite",
    provider: "groq",
    providerModel: "llama-3.1-8b-instant",
    description: "Fast, lightweight model for quick everyday questions.",
  },
  {
    id: "cyber-flash",
    label: "cyber flash",
    provider: "groq",
    providerModel: "openai/gpt-oss-20b",
    description: "High-speed model balancing power and response time.",
  },
  {
    id: "cyber-pro",
    label: "cyber pro",
    provider: "groq",
    providerModel: "llama-3.3-70b-versatile",
    description: "Most capable model for complex, demanding tasks.",
  },
  {
    id: "cyber-expert",
    label: "cyber expert",
    provider: "groq-expert",
    providerModel: "openai/gpt-oss-120b",
    description: "Larger, more capable model for demanding expert-level tasks.",
  },
  {
    id: "cyber-vision",
    label: "cyber vision",
    provider: "gemini",
    providerModel: "gemini-flash-latest",
    description: "Multimodal model that can also see and analyze images.",
    supportsImages: true,
  },
];

export function resolveModel(displaySlug: string): CyberModel {
  const match = CYBER_MODELS.find((m) => m.id === displaySlug);
  if (!match) {
    throw new Error(`Unknown model: ${displaySlug}`);
  }
  return match;
}

export function getDefaultModelId(): string {
  return CYBER_MODELS[0].id;
}