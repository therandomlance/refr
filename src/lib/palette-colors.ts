export const MAX_PALETTE_COLORS = 10;

/** Move one swatch by index, including when multiple swatches have the same hex. */
export function reorderColor(colors: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || from >= colors.length || to < 0 || to >= colors.length) return colors;
  const next = [...colors];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** "abc" / "#ABC" / " #aabbcc " → "#aabbcc"; null when not a 3- or 6-digit hex. */
export function normalizeHex(input: string): string | null {
  const v = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(v)) return `#${v}`;
  if (/^[0-9a-f]{3}$/.test(v)) return `#${[...v].map((c) => c + c).join("")}`;
  return null;
}

/** readable text color on a hex swatch */
export function contrast(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return l > 140 ? "#000" : "#fff";
}

/** Filesystem-safe download name for an exported palette. */
export function exportFileName(name: string, ext: string): string {
  const base = name.trim().replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return `${base || "palette"}.${ext}`;
}

/** Striped square PNG via canvas → download. Hex codes drawn on the stripes like the preview. */
export function exportPng(name: string, colors: string[]) {
  const size = 800;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const h = size / colors.length;
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, i * h, size, h);
    ctx.fillStyle = contrast(c);
    ctx.font = `${Math.min(48, Math.max(12, Math.round(h * 0.35)))}px monospace`;
    ctx.textBaseline = "middle";
    ctx.fillText(c, 16, i * h + h / 2);
  });
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = exportFileName(name, "png");
  a.click();
}
