"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "refr/trpc/react";
import { MediaGrid } from "refr/app/_components/media-grid";
import { SidePanel } from "refr/app/_components/side-panel";
import { TagInput } from "refr/app/_components/tag-input";
import { useFileContextMenu } from "refr/app/_components/file-menu";
import { SavedSearches } from "refr/app/_components/saved-searches";
import { PromptDialog } from "refr/app/_components/dialog";
import { commitToken, isVectorToken, parseQuery, serializeQuery, tokenSchema, type Sort, type Token } from "refr/server/services/search";
import { KEYWORD_NAMES } from "refr/lib/keywords";
import { useSuggestionActions } from "refr/app/_components/tag-actions";
import { Icon } from "refr/app/_components/icon";

export default function SearchPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [tokens, setTokens] = useState<Token[]>(() => tokensFromUrl(params));
  const [sort, setSort] = useState<Sort>("date");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [savePrompt, setSavePrompt] = useState(false);
  const [hideReviewed, setHideReviewed] = useState(false);
  const fileMenu = useFileContextMenu(selection, setSelection);

  const saved = api.searches.list.useQuery();
  const utils = api.useUtils();
  const saveM = api.searches.save.useMutation({ onSuccess: () => void utils.searches.list.invalidate() });

  // suggest:<tag> chip → tiles get the same accept/deny actions as the browse
  // suggestion strips, scoped to that tag.
  const suggestTag = tokens.find((t) => t.kind === "tag" && t.tag.startsWith("suggest:"))?.tag.slice("suggest:".length);
  const decisions = useSuggestionActions(suggestTag ?? null);
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

  const hasVectorChip = tokens.some(isVectorToken);
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
    (raw: string, suggestion?: string) => {
      // quote-prefixed = semantic text chip from the autocomplete fallback row
      if (raw.startsWith('"')) {
        const value = raw.slice(1);
        setTokens((ts) =>
          ts.some(isVectorToken) ? ts : [...ts, { kind: "text", tag: value, negate: false, exact: false, or: false, wildcard: false }],
        );
        return;
      }
      const token = commitToken(raw, suggestion);
      if (!token) return;
      if (isVectorToken(token)) {
        setTokens((ts) => (ts.some(isVectorToken) ? ts : [...ts, token]));
        return;
      }
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
        <SavedSearches
          nodes={saved.data ?? []}
          onOpen={(s) => {
            setTokens(s.tokens);
            if (s.sort) setSort(s.sort);
          }}
        />
      </SidePanel>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="page-header"><div><h1>Search</h1><p>Find references by tag, path, or similarity.</p></div></header>
        <MediaGrid
          toolbarSearch={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                  ) : t.kind === "tag" && t.tag.startsWith("suggest:") ? (
                    <span className="mod">✦</span>
                  ) : (
                    (t.negate || t.or || t.exact) && (
                      <span className="mod">{t.negate ? "-" : ""}{t.or ? "~" : ""}{t.exact ? "=" : ""}</span>
                    )
                  )}
                  {t.tag}
                </>
              )}
              <button className="x" aria-label={`Remove ${t.tag} filter`} onClick={() => removeChip(i)}><Icon name="close" /></button>
            </span>
          ))}
          <div className="min-w-0 basis-48 flex-1">
            <TagInput
              placeholder={tokens.length === 0 ? "Search tags…  (- not, ~ or, = exact, * wildcard, path:<folder|alias> (= exact), suggest: for-tag)" : ""}
              onCommit={addChip}
              keywords={KEYWORD_NAMES}
              semanticFallback={mlStatus.data?.state === "ready" && !hasVectorChip}
              pathAutocomplete
              suggestAutocomplete
            />
          </div>
        </div>
          }
          header={hasVectorChip && mlStatus.data?.state !== "ready" ? <p role="status" className="state-message">Semantic search is unavailable. Tag filters still work.</p> : undefined}
          source={{ kind: "search", tokens }}
          sort={sort}
          onSortChange={setSort}
          selection={selection}
          onSelectionChange={setSelection}
          onContextMenu={fileMenu.open}
          emptyState={tokens.length === 0 ? "Type a tag to search." : "No matches."}
          hiddenIds={suggestTag && hideReviewed ? decisions.hiddenIds : undefined}
          toolbarActions={suggestTag ? (
            <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-dim)" }} title="Later thumbnails shift forward without resizing">
              <input type="checkbox" checked={hideReviewed} onChange={(e) => setHideReviewed(e.target.checked)} />
              Hide reviewed thumbnails
            </label>
          ) : undefined}
          tileActions={
            suggestTag
              ? (f) => (
                  decisions.hiddenIds.has(f.id) ? (
                    <span className="absolute top-2 left-2 rounded px-2 py-1 text-xs" style={{ background: "var(--panel)", color: "var(--text)" }}>Reviewed ✓</span>
                  ) : (
                  <>
                    <button
                      className="check"
                      style={{ opacity: 1, background: "var(--accent)", color: "var(--accent-fg)", borderColor: "var(--accent)", width: 32, height: 32, fontSize: 18 }}
                      title="Accept tag"
                      disabled={decisions.isPending(f.id)}
                      onClick={(e) => { e.stopPropagation(); decisions.accept(f.id); }}
                    >
                      <Icon name="check" />
                    </button>
                    <button
                      className="deny"
                      style={{ opacity: 1, background: "var(--danger)", borderColor: "var(--danger)", width: 32, height: 32, fontSize: 18 }}
                      title="Exclude from suggestions"
                      disabled={decisions.isPending(f.id)}
                      onClick={(e) => { e.stopPropagation(); decisions.deny(f.id); }}
                    >
                      <Icon name="close" />
                    </button>
                  </>
                  )
                )
              : undefined
          }
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
