"use client";
import { usePersistentBoolean, usePersistentNumber } from "refr/lib/persistent-state";

export const VALUE_STEPS = [0, 2, 3, 5] as const;
export const GRID_MODES = ["off", "thirds", "4x4"] as const;
export type GridMode = (typeof GRID_MODES)[number];

export type StudyTools = {
  flip: boolean;
  gray: boolean;
  blur: boolean;
  /** posterize to N value steps; 0 = off */
  value: (typeof VALUE_STEPS)[number];
  grid: GridMode;
};

/**
 * Drawing-study view toggles for the viewer (flip, grayscale, squint blur, value
 * steps, composition grid). Persisted so they follow you across images, reopens
 * and sessions.
 */
export function useStudyTools() {
  const [flip, setFlip] = usePersistentBoolean("refr:study-flip", () => false);
  const [gray, setGray] = usePersistentBoolean("refr:study-gray", () => false);
  const [blur, setBlur] = usePersistentBoolean("refr:study-blur", () => false);
  const [valueIdx, setValueIdx] = usePersistentNumber("refr:study-value", 0, 0, VALUE_STEPS.length - 1);
  const [gridIdx, setGridIdx] = usePersistentNumber("refr:study-grid", 0, 0, GRID_MODES.length - 1);
  const tools: StudyTools = {
    flip,
    gray,
    blur,
    value: VALUE_STEPS[valueIdx] ?? 0,
    grid: GRID_MODES[gridIdx] ?? "off",
  };
  return {
    tools,
    toggleFlip: () => setFlip((v) => !v),
    toggleGray: () => setGray((v) => !v),
    toggleBlur: () => setBlur((v) => !v),
    cycleValue: () => setValueIdx((valueIdx + 1) % VALUE_STEPS.length),
    cycleGrid: () => setGridIdx((gridIdx + 1) % GRID_MODES.length),
  };
}

/** CSS filter chain for the study toggles (value steps use the SVG filters in <StudyFilterDefs>). */
export function studyFilter(t: StudyTools): string | undefined {
  const f = [
    t.gray && !t.value ? "grayscale(1)" : "",
    t.value ? `url(#refr-value-${t.value})` : "",
    t.blur ? "blur(6px)" : "",
  ].filter(Boolean);
  return f.length ? f.join(" ") : undefined;
}
