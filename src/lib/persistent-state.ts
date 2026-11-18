import { useEffect, useState } from "react";

/**
 * A boolean toggle that persists across reloads in localStorage. The fallback
 * initializer is used for the first render (SSR-safe — no hydration mismatch),
 * then the stored value overrides after mount. Each change writes back.
 * try/catch covers private mode / disabled storage (Safari throws on access).
 */
export function usePersistentBoolean(
  key: string,
  fallback: () => boolean,
): readonly [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) setValue(stored === "1");
    } catch { /* storage unavailable */ }
  }, [key]);
  useEffect(() => {
    try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* ignore */ }
  }, [key, value]);
  return [value, setValue] as const;
}

/** A number that persists across reloads in localStorage (same contract as
 *  usePersistentBoolean). Stored values outside [min, max] are ignored. */
export function usePersistentNumber(
  key: string,
  fallback: number,
  min = -Infinity,
  max = Infinity,
): readonly [number, (v: number) => void] {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      const stored = raw === null ? NaN : Number(raw);
      if (Number.isFinite(stored) && stored >= min && stored <= max) setValue(stored);
    } catch { /* storage unavailable */ }
  }, [key, min, max]);
  useEffect(() => {
    try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
  }, [key, value]);
  return [value, setValue] as const;
}
