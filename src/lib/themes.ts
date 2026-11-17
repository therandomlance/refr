/** Base themes: surfaces + text only. Accent and density are independent settings. */
export const THEMES = ["obsidian", "midnight", "dusk", "fog", "paper"] as const;
export type Theme = (typeof THEMES)[number];
export const LIGHT_THEMES: readonly Theme[] = ["fog", "paper"];

export const ACCENTS = ["blue", "violet", "rose", "amber", "lime", "teal", "cyan", "mono"] as const;
export type Accent = (typeof ACCENTS)[number];

export const DENSITIES = ["compact", "comfortable", "spacious"] as const;
export type Density = (typeof DENSITIES)[number];

/** Pre-overhaul theme ids → nearest new theme + accent, so old config.yaml files keep loading. */
export const LEGACY_THEME_MAP: Record<string, { theme: Theme; accent: Accent }> = {
  graphite: { theme: "obsidian", accent: "mono" },
  ink: { theme: "midnight", accent: "blue" },
  espresso: { theme: "dusk", accent: "amber" },
  moss: { theme: "obsidian", accent: "lime" },
  aubergine: { theme: "dusk", accent: "violet" },
  burgundy: { theme: "dusk", accent: "rose" },
  parchment: { theme: "paper", accent: "amber" },
  porcelain: { theme: "fog", accent: "blue" },
  slate: { theme: "midnight", accent: "blue" },
  paper: { theme: "paper", accent: "amber" },
  ember: { theme: "dusk", accent: "amber" },
  forest: { theme: "obsidian", accent: "teal" },
  velvet: { theme: "dusk", accent: "violet" },
  mono: { theme: "obsidian", accent: "mono" },
};

