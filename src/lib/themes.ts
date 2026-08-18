export const THEMES = ["slate", "paper", "ember", "forest", "velvet", "mono"] as const;
export type Theme = (typeof THEMES)[number];
