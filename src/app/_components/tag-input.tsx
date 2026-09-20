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
  pathAutocomplete = false,
  suggestAutocomplete = false,
}: {
  placeholder?: string;
  onCommit: (raw: string, suggestion?: string) => void;
  onRawChange?: (raw: string) => void;
  /** when true and no tag matches, last row is "Semantic: '<input>'" */
  semanticFallback?: boolean;
  /** metadata keywords (e.g. search's `untagged`) offered as suggestions */
  keywords?: readonly string[];
  autoFocus?: boolean;
  /** when true, input starting with `path:` offers library path completions */
  pathAutocomplete?: boolean;
  /** when true, input starting with `suggest:` offers tag completions (search) */
  suggestAutocomplete?: boolean;
}) {
  const [raw, setRaw] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [debounced, setDebounced] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(stripModifiers(raw)), 150);
    return () => clearTimeout(t);
  }, [raw]);

  const pathMode = pathAutocomplete && debounced.startsWith("path:");
  const suggestMode = suggestAutocomplete && !pathMode && debounced.startsWith("suggest:");
  const pathTyped = pathMode ? debounced.slice(5) : "";
  const suggestTyped = suggestMode ? debounced.slice(8) : "";
  const tagTerm = suggestMode ? suggestTyped : debounced;

  const suggestions = api.tags.search.useQuery(
    { term: tagTerm, limit: 20 },
    // in suggest: mode even an empty term lists tags (all get the suggest: prefix)
    { enabled: (tagTerm.length > 0 && !pathMode) || suggestMode },
  );
  const pathSuggestions = api.files.pathComplete.useQuery(
    { typed: pathTyped },
    { enabled: pathMode },
  );

  const tagRows = suggestions.data ?? [];
  const pathRows = pathMode ? (pathSuggestions.data ?? []).map((p) => ({ name: "path:" + p })) : [];
  const suggestRows = suggestMode
    ? tagRows.map((r) => ({ name: "suggest:" + r.name, count: r.count }))
    : [];
  const keywordRows = !pathMode && !suggestMode
    ? keywords.filter((k) => k.includes(debounced) && !tagRows.some((r) => r.name === k)).map((k) => ({ name: k }))
    : [];
  // fill-rows for value-carrying keywords: offered while typing toward them
  // (and when the input is empty, so they show among the plain keywords). Once
  // active, their own completion mode takes over.
  const suggestRow = suggestAutocomplete && !pathMode && !suggestMode && "suggest:".includes(debounced)
    ? [{ name: "suggest:" }]
    : [];
  const pathRow = pathAutocomplete && !pathMode && !suggestMode && "path:".includes(debounced)
    ? [{ name: "path:" }]
    : [];
  const rows: { name: string; count?: number }[] = [
    ...pathRow,
    ...suggestRow,
    ...pathRows,
    ...(suggestMode ? suggestRows : tagRows),
    ...keywordRows,
  ];
  const showSemantic = semanticFallback && !pathMode && !suggestMode && raw.trim().length > 0 && rows.length === 0 && suggestions.isFetched;
  const rowCount = rows.length + (showSemantic ? 1 : 0);

  useEffect(() => setHighlight(0), [debounced]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const commit = (value: string, suggestion?: string) => {
    onCommit(value, suggestion);
    setRaw("");
    setOpen(false);
    onRawChange?.("");
  };

  const commitSemantic = () => {
    // quote-prefixed — the caller's parser turns this into a text chip
    commit(`"${stripModifiers(raw)}"`);
  };

  // selecting a fill-row keyword ("suggest:" / "path:") fills the input (more
  // typing expected) instead of committing a chip
  const fillKeyword = (prefix: string) => {
    setRaw(prefix);
    onRawChange?.(prefix);
    setOpen(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.setSelectionRange(prefix.length, prefix.length); }
    });
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        className="taginput"
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={raw}
        ref={inputRef}
        onChange={(e) => {
          setRaw(e.target.value);
          setOpen(true);
          onRawChange?.(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, rowCount - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Tab" && open && rows[highlight]) {
            e.preventDefault();
            const filled = applyModifiers(raw, rows[highlight].name);
            setRaw(filled);
            onRawChange?.(filled);
            setOpen(true);
            requestAnimationFrame(() => {
              const el = inputRef.current;
              if (el) { el.focus(); el.setSelectionRange(filled.length, filled.length); }
            });
          }
          else if (e.key === "Enter") {
            e.preventDefault();
            const pick = open ? rows[highlight] : undefined;
            // dropdown closed (Esc / outside click) → add exactly what was typed;
            // no stale suggestion may override the literal input
            if (!open) {
              if (raw.trim()) commit(raw.trim());
            } else if (showSemantic && highlight === rows.length) {
              commitSemantic();
            } else if (pick?.name === "suggest:" || pick?.name === "path:") {
              fillKeyword(pick.name);
            } else if (pick) {
              commit(applyModifiers(raw, pick.name), pick.name);
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
              onClick={() => (r.name === "suggest:" || r.name === "path:" ? fillKeyword(r.name) : commit(r.name, r.name))}
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
