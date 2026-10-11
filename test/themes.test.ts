import fs from "node:fs";
import { expect, it } from "vitest";
import { PALETTES, LEGACY_THEMES } from "refr/lib/themes";
import * as config from "refr/server/services/config";

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map((v) => {
    const c = Number.parseInt(v, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}

it("persists new and original themes; curated palettes have readable text and accent buttons", () => {
  const original = config.get().theme;
  const css = fs.readFileSync("src/styles/globals.css", "utf8");
  try {
    for (const theme of [...PALETTES, ...LEGACY_THEMES]) {
      config.patch({ theme });
      expect(config.get().theme).toBe(theme);
    }
    for (const theme of PALETTES) {
      const block = css.match(new RegExp(`^\\[data-theme="${theme}"\\] \\{([^}]+)\\}`, "m"))![1]!;
      const colors = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
      for (const [fg, bg] of [
        ["text", "bg"], ["text", "panel"], ["text-dim", "bg"], ["text-dim", "panel"],
        ["text-faint", "bg"], ["text-faint", "panel"], ["accent-fg", "accent"], ["accent", "active"],
      ]) {
        const a = luminance(colors[fg!]!);
        const b = luminance(colors[bg!]!);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    config.patch({ theme: original });
  }
});
