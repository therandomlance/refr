"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "refr/trpc/react";

/**
 * Autocomplete tag input (§10.3). Debounced 150ms, keyboard navigable,
 * Enter commits highlight. `parseInput` lets callers extract -/~/= modifiers.
 */
export function TagInput({
  placeholder = "Add tag…",
  onCommit,
  onRawChange,
  semanticFallback = false,
  keywords = [],
  autoFocus = false,
}: {
  placeholder?: string;
  onCommit: (raw: string, suggestion?: string) => void;
  onRawChange?: (raw: string) => void;
  /** when true and no tag matches, last row is "Semantic: '<input>'" */
  semanticFallback?: boolean;
  /** metadata keywords (e.g. search's `untagged`) offered as suggestions */
  keywords?: readonly string[];
  autoFocus?: boolean;
}) {
  const [raw, setRaw] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [debounced, setDebounced] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(stripModifiers(raw)), 150);
    return () => clearTimeout(t);
  }, [raw]);

  const suggestions = api.tags.search.useQuery(
    { term: debounced, limit: 20 },
    { enabled: debounced.length > 0 },
  );

  const tagRows = suggestions.data ?? [];
  const keywordRows = debounced
    ? keywords.filter((k) => k.includes(debounced) && !tagRows.some((r) => r.name === k)).map((k) => ({ name: k }))
    : [];
  const rows: { name: string; count?: number }[] = [...tagRows, ...keywordRows];
  const showSemantic = semanticFallback && raw.trim().length > 0 && rows.length === 0 && suggestions.isFetched;
  const rowCount = rows.length + (showSemantic ? 1 : 0);

  useEffect(() => setHighlight(0), [debounced]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const commit = (value: string) => {
    onCommit(value);
    setRaw("");
    setOpen(false);
    onRawChange?.("");
  };

  const commitSemantic = () => {
    // quote-prefixed — the caller's parser turns this into a text chip
    commit(`"${stripModifiers(raw)}"`);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        className="taginput"
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          setOpen(true);
          onRawChange?.(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, rowCount - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") {
            e.preventDefault();
            if (showSemantic && highlight === rows.length) {
              commitSemantic();
            } else if (rows[highlight]) {
              commit(applyModifiers(raw, rows[highlight].name));
            } else if (raw.trim()) {
              commit(raw.trim());
            }
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && rowCount > 0 && (
        <div className="ctxmenu" style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 4, maxHeight: 280, overflowY: "auto" }}>
          {rows.map((r, i) => (
            <button
              key={r.name}
              style={i === highlight ? { background: "var(--hover)" } : undefined}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(r.name)}
            >
              {r.name} {r.count != null && <span style={{ color: "var(--text-faint)", marginLeft: "auto" }}>{r.count}</span>}
            </button>
          ))}
          {showSemantic && (
            <button
              style={highlight === rows.length ? { background: "var(--hover)" } : undefined}
              onMouseEnter={() => setHighlight(rows.length)}
              onClick={commitSemantic}
            >
              Semantic: &lsquo;{stripModifiers(raw)}&rsquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function stripModifiers(raw: string): string {
  return raw.replace(/^[-~=]+/, "").trim();
}

/** Attach typed -/~/= prefixes onto the committed tag name. */
export function applyModifiers(raw: string, tag: string): string {
  const m = /^[-~=]+/.exec(raw);
  return (m?.[0] ?? "") + tag;
}
