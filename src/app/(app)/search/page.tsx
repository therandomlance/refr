"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { SidePanel } from "refr/app/_components/side-panel";
import { TagInput } from "refr/app/_components/tag-input";
import { useFileContextMenu } from "refr/app/_components/file-menu";
import { ContextMenu } from "refr/app/_components/context-menu";
import { ConfirmDialog, PromptDialog } from "refr/app/_components/dialog";
import { parseQuery, serializeQuery, tokenSchema, type Sort, type Token } from "refr/server/services/search";
import { KEYWORD_NAMES } from "refr/lib/keywords";

export default function SearchPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [tokens, setTokens] = useState<Token[]>(() => tokensFromUrl(params));
  const [sort, setSort] = useState<Sort>("date");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [savePrompt, setSavePrompt] = useState(false);
  const [savedMenu, setSavedMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [renameOf, setRenameOf] = useState<string | null>(null);
  const [deleteOf, setDeleteOf] = useState<string | null>(null);
  const fileMenu = useFileContextMenu(selection, setSelection);

  const saved = api.searches.list.useQuery();
  const utils = api.useUtils();
  const saveM = api.searches.save.useMutation({ onSuccess: () => void utils.searches.list.invalidate() });
  const deleteM = api.searches.delete.useMutation({ onSuccess: () => void utils.searches.list.invalidate() });
  const renameM = api.searches.rename.useMutation({ onSuccess: () => void utils.searches.list.invalidate() });

  // keep ?q= in sync (JSON form — shareable)
  useEffect(() => {
    const p = new URLSearchParams(params.toString());
    if (tokens.length === 0) p.delete("q");
    else p.set("q", JSON.stringify(tokens));
    const next = p.toString();
    const current = params.toString();
    if (next !== current) router.replace(next ? `${pathname}?${next}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens]);

  // reverse sync: external URL changes (e.g. file-menu "Find similar" push,
  // back/forward) → tokens. Content-compared to avoid looping with the writer
  // above (our own router.replace produces params that match current tokens).
  useEffect(() => {
    const urlTokens = tokensFromUrl(params);
    if (JSON.stringify(urlTokens) !== JSON.stringify(tokens)) setTokens(urlTokens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const hasVectorChip = tokens.some((t) => t.kind === "text" || t.kind === "similar");
  const mlStatus = api.ml.status.useQuery();

  // similarity is the natural ordering for semantic/similar search; revert to
  // date when the vector chip is removed
  useEffect(() => {
    if (hasVectorChip) {
      if (sort !== "similarity") setSort("similarity");
    } else if (sort === "similarity") {
      setSort("date");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasVectorChip]);

  const addChip = useCallback(
    (raw: string) => {
      // quote-prefixed = semantic text chip from the autocomplete fallback row
      if (raw.startsWith('"')) {
        const value = raw.slice(1);
        setTokens((ts) =>
          ts.some((t) => t.kind === "text") ? ts : [...ts, { kind: "text", tag: value, negate: false, exact: false, or: false, wildcard: false }],
        );
        return;
      }
      const [token] = parseQuery(raw);
      if (!token) return;
      setTokens((ts) => [...ts, token]);
    },
    [],
  );

  const removeChip = (i: number) => setTokens((ts) => ts.filter((_, j) => j !== i));

  return (
    <div className="flex min-h-0 flex-1">
      <SidePanel
        head={
          <>
            <h2 className="text-[13px] font-semibold">Saved searches</h2>
            <button className="btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setSavePrompt(true)} disabled={tokens.length === 0}>
              Save
            </button>
          </>
        }
      >
        <div className="flex-1 px-2 pb-4">
          {(saved.data ?? []).map((s) => (
            <div
              key={s.name}
              className="trow"
              onClick={() => {
                setTokens(s.tokens);
                if (s.sort) setSort(s.sort);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSavedMenu({ name: s.name, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="overflow-hidden text-ellipsis">{s.name}</span>
            </div>
          ))}
          {saved.data?.length === 0 && (
            <p className="px-2 text-xs" style={{ color: "var(--text-faint)" }}>No saved searches yet.</p>
          )}
        </div>
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none flex-wrap items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          {tokens.map((t, i) => (
            <span key={i} className="chip">
              {t.kind === "similar" ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/thumb/${t.tag}`} className="h-5 w-5 rounded object-cover" alt="" />
                  <span className="mod">↭</span>
                  Similar
                </>
              ) : (
                <>
                  {t.kind === "text" ? (
                    <span className="mod">⌕</span>
                  ) : (
                    (t.negate || t.or || t.exact) && (
                      <span className="mod">{t.negate ? "-" : ""}{t.or ? "~" : ""}{t.exact ? "=" : ""}</span>
                    )
                  )}
                  {t.tag}
                </>
              )}
              <button className="x" onClick={() => removeChip(i)}>✕</button>
            </span>
          ))}
          <div className="min-w-48 flex-1">
            <TagInput
              placeholder={tokens.length === 0 ? "Search tags…  (- not, ~ or, = exact, * wildcard, path: filter)" : ""}
              onCommit={addChip}
              keywords={KEYWORD_NAMES}
              semanticFallback={mlStatus.data?.state === "ready" && !hasVectorChip}
              pathAutocomplete
            />
          </div>
        </div>

        <MediaGrid
          source={{ kind: "search", tokens }}
          sort={sort}
          onSortChange={setSort}
          selection={selection}
          onSelectionChange={setSelection}
          onContextMenu={fileMenu.open}
          emptyState={tokens.length === 0 ? "Type a tag to search." : "No matches."}
        />
      </main>

      {fileMenu.element}
      {savePrompt && (
        <PromptDialog
          title="Save search"
          label={`Name for: ${serializeQuery(tokens)}`}
          onSubmit={(name) => saveM.mutate({ name, tokens, sort })}
          onClose={() => setSavePrompt(false)}
        />
      )}
      {savedMenu && (
        <ContextMenu
          x={savedMenu.x}
          y={savedMenu.y}
          onClose={() => setSavedMenu(null)}
          items={[
            { label: "Rename…", onClick: () => setRenameOf(savedMenu.name) },
            { label: "Delete…", onClick: () => setDeleteOf(savedMenu.name), danger: true },
          ]}
        />
      )}
      {renameOf && (
        <PromptDialog
          title="Rename search"
          label="New name"
          initial={renameOf}
          onSubmit={(v) => renameM.mutate({ oldName: renameOf, newName: v })}
          onClose={() => setRenameOf(null)}
        />
      )}
      {deleteOf && (
        <ConfirmDialog
          title="Delete saved search"
          body={<>Delete <b>{deleteOf}</b>?</>}
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteM.mutate({ name: deleteOf })}
          onClose={() => setDeleteOf(null)}
        />
      )}
    </div>
  );
}

function tokensFromUrl(params: URLSearchParams): Token[] {
  const q = params.get("q");
  if (!q) return [];
  try {
    const parsed: unknown = JSON.parse(q);
    return Array.isArray(parsed) ? parsed.map((t) => tokenSchema.parse(t)) : [];
  } catch {
    // tolerate legacy pretty-string URLs
    return parseQuery(q);
  }
}
