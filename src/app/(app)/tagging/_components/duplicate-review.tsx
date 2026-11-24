"use client";

import { useState } from "react";
import Link from "next/link";
import { api, type RouterOutputs } from "refr/trpc/react";

type Pair = RouterOutputs["duplicates"]["list"]["pairs"][number];
type PairFile = Pair["a"];

const PAGE = 20;

const pixels = (f: PairFile) => (f.width ?? 0) * (f.height ?? 0);
const formatBytes = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1 << 10 ? `${Math.round(n / (1 << 10))} KB` : `${n} B`;

/**
 * Tagging → Duplicates: near-identical image pairs (dHash, duplicates.ts).
 * "Keep" merges the other file's tags/favorite/notes onto the kept one and
 * hides the other from every grid (search `is:duplicate` to see hidden copies).
 * Library files are never touched.
 */
export function DuplicateReview({ fileId }: { fileId: string | null }) {
  const utils = api.useUtils();
  const [offset, setOffset] = useState(0);
  const list = api.duplicates.list.useQuery(
    { fileId: fileId ?? undefined, offset, limit: PAGE },
    { refetchInterval: (q) => (q.state.data?.hashing.running ? 4000 : false) },
  );
  const after = () => {
    void utils.duplicates.invalidate();
    void utils.files.invalidate();
    void utils.search.invalidate();
  };
  const resolve = api.duplicates.resolve.useMutation({ onSuccess: after });
  const dismiss = api.duplicates.dismiss.useMutation({ onSuccess: after });
  const rehash = api.duplicates.rehash.useMutation({ onSuccess: () => void utils.duplicates.invalidate() });
  const busy = resolve.isPending || dismiss.isPending;

  const data = list.data;
  const hashing = data?.hashing;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
        {fileId && (
          <span className="chip">
            Pairs with one file
            <Link className="x" href="/tagging?view=duplicates" aria-label="Show all pairs">×</Link>
          </span>
        )}
        <span>
          {hashing?.running
            ? `Fingerprinting images… ${hashing.done}/${hashing.total}`
            : data ? `${data.total} pair${data.total === 1 ? "" : "s"} found` : "Loading…"}
        </span>
        <button className="btn sm" disabled={(hashing?.running ?? false) || rehash.isPending} onClick={() => rehash.mutate()} title="Fingerprint images that don't have one yet">
          Check new images
        </button>
        <Link className="text-accent underline" href={`/search?q=${encodeURIComponent(JSON.stringify([{ kind: "tag", tag: "is:duplicate", negate: false, exact: false, or: false, wildcard: false }]))}`}>
          View hidden duplicates
        </Link>
      </div>

      {data?.pairs.length === 0 && (
        <p className="text-sm text-fg-subtle">
          {hashing?.running ? "Still fingerprinting. Pairs appear here as images are checked." : "No near-duplicates found."}
        </p>
      )}

      <div className="flex flex-col gap-4">
        {data?.pairs.map((p) => {
          // the preferred (larger) image always sits on the left
          const [left, right] = pixels(p.a) >= pixels(p.b) ? [p.a, p.b] : [p.b, p.a];
          const bigger = left.id;
          return (
            <div key={`${p.a.id}|${p.b.id}`} className="card p-3">
              <div className="grid grid-cols-2 gap-3">
                {[left, right].map((f, i) => (
                  <div key={f.id} className="flex min-w-0 flex-col gap-2">
                    <a href={`/api/file/${f.id}`} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md bg-surface-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/thumb/${f.id}`} alt="" className="mx-auto block max-h-72 w-auto object-contain" loading="lazy" />
                    </a>
                    <div className="text-xs text-fg-muted">
                      <div className="flex flex-wrap gap-x-3">
                        <b className="text-fg">{f.width && f.height ? `${f.width} × ${f.height}` : "Unknown size"}</b>
                        <span>{formatBytes(f.size)}</span>
                        <span>{f.tags} tag{f.tags === 1 ? "" : "s"}</span>
                        {f.id === bigger && pixels(left) !== pixels(right) && <span className="text-accent">Larger</span>}
                      </div>
                      <div className="truncate text-fg-subtle" title={f.path ?? undefined}>{f.path ?? "Missing from disk"}</div>
                    </div>
                    <button
                      className={`btn ${f.id === bigger ? "primary" : ""}`}
                      disabled={busy}
                      onClick={() => resolve.mutate({ keeper: f.id, copy: (i === 0 ? right : left).id })}
                    >
                      Keep {i === 0 ? "left" : "right"}
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs text-fg-subtle">
                <span>{p.distance === 0 ? "Visually identical" : `${p.distance} bit${p.distance === 1 ? "" : "s"} different`}</span>
                <button className="btn sm ghost" disabled={busy} onClick={() => dismiss.mutate({ a: p.a.id, b: p.b.id })}>
                  Not duplicates
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {data && data.total > PAGE && (
        <div className="mt-4 flex items-center gap-2 text-xs text-fg-subtle">
          <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <span>{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
          <button className="btn sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      )}
    </div>
  );
}
