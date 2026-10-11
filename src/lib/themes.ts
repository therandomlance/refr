export const PALETTES = ["graphite", "ink", "espresso", "moss", "aubergine", "burgundy", "parchment", "porcelain"] as const;
export const LEGACY_THEMES = ["slate", "paper", "ember", "forest", "velvet", "mono"] as const;
export const THEMES = [...PALETTES, ...LEGACY_THEMES] as const;
export type Theme = (typeof THEMES)[number];
