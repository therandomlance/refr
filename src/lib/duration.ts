/** Empty = untimed; invalid drafts stay strings until the user finishes editing. */
export function parseDuration(value: string): number | null | undefined {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+(?::[0-5]?\d)?$/.test(text)) return undefined;
  const parts = text.split(":").map(Number);
  const seconds = parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]!;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

export function formatDurationInput(seconds: number | null): string {
  return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
}
