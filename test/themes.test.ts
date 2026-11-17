import fs from "node:fs";
import { expect, it } from "vitest";
import { THEMES, ACCENTS, DENSITIES, LIGHT_THEMES, LEGACY_THEME_MAP } from "refr/lib/themes";
import * as config from "refr/server/services/config";

const css = fs.readFileSync("src/styles/globals.css", "utf8");

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map((v) => {
    const c = Number.parseInt(v, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function tokens(selector: string) {
  const escaped = selector.replace(/[[\]"]/g, "\\$&");
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))![1]!;
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
}

it("persists theme, accent and density", () => {
  const { theme, accent, density } = config.get();
  try {
    for (const t of THEMES) { config.patch({ theme: t }); expect(config.get().theme).toBe(t); }
    for (const a of ACCENTS) { config.patch({ accent: a }); expect(config.get().accent).toBe(a); }
    for (const d of DENSITIES) { config.patch({ density: d }); expect(config.get().density).toBe(d); }
  } finally {
    config.patch({ theme, accent, density });
  }
});

it("maps pre-overhaul theme ids to a new theme and accent", () => {
  const { theme, accent } = config.get();
  try {
    for (const [legacy, mapped] of Object.entries(LEGACY_THEME_MAP)) {
      config.patch({ theme: legacy });
      expect(config.get().theme, legacy).toBe(mapped.theme);
    }
    // no accent in the file → the legacy theme's accent is adopted
    const raw = fs.readFileSync(`${process.env.DATA_DIR}/config.yaml`, "utf8")
      .replace(/^accent:.*$/m, "").replace(/^theme:.*$/m, "theme: parchment");
    fs.writeFileSync(`${process.env.DATA_DIR}/config.yaml`, raw);
    const now = new Date(Date.now() + 5000);
    fs.utimesSync(`${process.env.DATA_DIR}/config.yaml`, now, now);
    expect(config.get()).toMatchObject({ theme: "paper", accent: "amber" });
  } finally {
    config.patch({ theme, accent });
  }
});

it("themes have readable text; accents have readable labels and visible fills", () => {
  for (const theme of THEMES) {
    const t = tokens(`[data-theme="${theme}"]`);
    for (const fg of ["fg", "fg-muted", "fg-subtle"]) {
      for (const bg of ["surface-0", "surface-1", "surface-2", "surface-3"]) {
        expect(contrast(t[fg]!, t[bg]!), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    const light = LIGHT_THEMES.includes(theme);
    for (const accent of ACCENTS) {
      const a = tokens(accent === "blue" ? `:root, [data-accent="blue"]` : `[data-accent="${accent}"]`);
      const [fill, label] = light ? [a["accent-light"]!, a["on-accent-light"]!] : [a["accent-dark"]!, a["on-accent-dark"]!];
      expect(contrast(fill, label), `${accent} label`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fill, t["surface-1"]!), `${theme}/${accent} accent on surface`).toBeGreaterThanOrEqual(3);
    }
  }
});
