export interface CyberModel {
  id: string;
  label: string;
  groqModel: string;
  description: string;
}

export const CYBER_MODELS: CyberModel[] = [
  {
    id: "cyber-lite",
    label: "cyber lite",
    groqModel: "llama-3.1-8b-instant",
    description: "Fast, lightweight model for quick everyday questions.",
  },
  {
    id: "cyber-flash",
    label: "cyber flash",
    groqModel: "openai/gpt-oss-20b",
    description: "High-speed model balancing power and response time.",
  },
  {
    id: "cyber-pro",
    label: "cyber pro",
    groqModel: "llama-3.3-70b-versatile",
    description: "Most capable model for complex, demanding tasks.",
  },
];

export function resolveGroqModel(displaySlug: string): string {
  const match = CYBER_MODELS.find((m) => m.id === displaySlug);
  if (!match) {
    throw new Error(`Unknown model: ${displaySlug}`);
  }
  return match.groqModel;
}

export function getDefaultModelId(): string {
  return CYBER_MODELS[0].id;
}