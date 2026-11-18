"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { isTypingTarget, overlayOpen } from "refr/lib/keyboard";
import { applyModifiers, isFillRow, resolveEnter, stripModifiers } from "refr/lib/tag-input-pick";
import { parseValueKeyword } from "refr/lib/keywords";

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
  keywordHints = [],
  autoFocus = false,
  pathAutocomplete = false,
  suggestAutocomplete = false,
  hotkey = false,
  seed,
}: {
  placeholder?: string;
  onCommit: (raw: string, suggestion?: string) => void;
  onRawChange?: (raw: string) => void;
  /** when true and no tag matches, last row is "Semantic: '<input>'" */
  semanticFallback?: boolean;
  /** metadata keywords (e.g. search's `untagged`) offered as suggestions */
  keywords?: readonly string[];
  /** value-keyword prefixes (`w>`, `added:`…) offered as fill rows once typing starts toward them */
  keywordHints?: readonly string[];
  autoFocus?: boolean;
  /** when true, input starting with `path:` offers library path completions */
  pathAutocomplete?: boolean;
  /** when true, input starting with `suggest:` offers tag completions (search) */
  suggestAutocomplete?: boolean;
  /** when true, pressing `/` anywhere (outside inputs/overlays) focuses this input */
  hotkey?: boolean;
  /** pre-fill the input and focus it; `key` changes re-apply the same text */
  seed?: { text: string; key: number } | null;
}) {
  const [raw, setRaw] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // user moved the highlight since rows last changed (arrows / hover)
  const [navigated, setNavigated] = useState(false);
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
  const typedLower = debounced.toLowerCase();
  const hintRows = !pathMode && !suggestMode && typedLower
    ? keywordHints.filter((h) => h.startsWith(typedLower) && h !== typedLower).map((h) => ({ name: h }))
    : [];
  const rows: { name: string; count?: number }[] = [
    ...pathRow,
    ...suggestRow,
    ...pathRows,
    ...(suggestMode ? suggestRows : tagRows),
    // after tag rows so a short prefix ("a") never Enter-fills "added:" over a tag
    ...hintRows,
    ...keywordRows,
  ];
  const showSemantic = semanticFallback && !pathMode && !suggestMode && raw.trim().length > 0 && !parseValueKeyword(debounced) && rows.length === 0 && suggestions.isFetched;
  const rowCount = rows.length + (showSemantic ? 1 : 0);

  // Prefer the row that matches what was typed exactly (so Enter on a full tag
  // name — e.g. a chip put back for editing — doesn't pick a longer descendant).
  const exactRow = rows.findIndex((r) => r.name.toLowerCase() === debounced.toLowerCase());
  useEffect(() => {
    setHighlight(Math.max(0, exactRow));
    setNavigated(false);
  }, [debounced, exactRow]);

  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || overlayOpen()) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);

  useEffect(() => {
    if (!seed) return;
    setRaw(seed.text);
    onRawChange?.(seed.text);
    setOpen(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.setSelectionRange(seed.text.length, seed.text.length); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

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

  // one path for Enter-pick and click, so typed -/~/= modifiers always apply
  const choose = (name: string) => {
    if (isFillRow(name)) fillKeyword(name);
    else commit(applyModifiers(raw, name), name);
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
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (rowCount > 0) { setHighlight((h) => Math.min(h + 1, rowCount - 1)); setNavigated(true); }
          }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); setNavigated(true); }
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
            const action = resolveEnter({ raw, debounced, open, rows, highlight, showSemantic, navigated });
            if (action.kind === "literal") commit(action.value);
            else if (action.kind === "semantic") commitSemantic();
            else if (action.kind === "fill") fillKeyword(action.prefix);
            else if (action.kind === "pick") choose(action.name);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && rowCount > 0 && (
        <div className="ctxmenu" style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 4, maxHeight: 280, overflowY: "auto" }}>
          {rows.map((r, i) => (
            <button
              key={r.name}
              style={i === highlight ? { background: "var(--accent-soft)" } : undefined}
              onMouseEnter={() => { setHighlight(i); setNavigated(true); }}
              onClick={() => choose(r.name)}
            >
              {r.name} {r.count != null && <span className="text-fg-subtle ml-auto">{r.count}</span>}
            </button>
          ))}
          {showSemantic && (
            <button
              style={highlight === rows.length ? { background: "var(--accent-soft)" } : undefined}
              onMouseEnter={() => { setHighlight(rows.length); setNavigated(true); }}
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
