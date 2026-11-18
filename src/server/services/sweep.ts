import "server-only";
import { db } from "refr/server/db";
import * as ml from "./ml";
import { tree } from "./tags";

/** Tagging-inbox sweep: score every file against every tag in the sidecar
 *  (/sweep, ml/tagmath.py) and cache calibrated candidates in TagCandidate.
 *
 *  - full sweep: after tag caches finish warming, if any embedding is newer than
 *    the last full sweep (new imports), or after rename/merge/delete;
 *  - per-tag sweep: tags whose vector/classifier was invalidated (accepts,
 *    denials, batch commits), debounced so a burst of edits is one pass.
 *
 *  In-process and best-effort like the other ML jobs: progress is lost on
 *  restart, and the next warm-up redoes it. */

const MIN_POSITIVES = 5; // tagmath.MIN_POSITIVES — tags below this aren't swept
const BATCH = 100; // target tags per /sweep request
const KEEP_FLOOR = 0.1; // candidates below this confidence aren't stored
const DEBOUNCE_MS = 1500;
const META_LAST_FULL = "tagSweep:lastFull";

type SweepState = {
  running: Promise<void> | null;
  full: boolean;
  dirty: Set<string>;
  progress: { done: number; total: number } | null;
  /** Tags in the pass currently running ("all" for a full pass). */
  current: Set<string> | "all" | null;
  lastFullAt: number | null;
  timer: NodeJS.Timeout | null;
  error?: string;
};
const g = globalThis as typeof globalThis & { refrTagSweep?: SweepState };
const state = g.refrTagSweep ??= {
  running: null, full: false, dirty: new Set(), progress: null, current: null, lastFullAt: null, timer: null,
};

export type SweepStatus = {
  running: boolean;
  progress: { done: number; total: number } | null;
  pending: number;
  lastFullAt: number | null;
  error?: string;
};

export function sweepStatus(): SweepStatus {
  return {
    running: state.running !== null,
    progress: state.progress,
    pending: state.dirty.size + (state.full ? 1 : 0),
    lastFullAt: state.lastFullAt,
    error: state.error,
  };
}

/** True while `tag` has an un-swept change queued or in flight. */
export function isSweepPending(tag: string): boolean {
  const c = state.current;
  return state.full || state.dirty.has(tag) || c === "all" || !!c?.has(tag);
}

/** Wire ml.ts cache events to the sweep. Called once at boot (instrumentation). */
export function registerSweepHooks() {
  ml.setSweepHooks({
    invalidated: (names) => (names ? requestSweep({ tags: names }) : requestSweep({ full: true })),
    warmed: () => void onWarmed(),
  });
}

export function requestSweep(opts: { full: true } | { tags: string[] }) {
  if ("full" in opts) state.full = true;
  else for (const t of opts.tags) state.dirty.add(t);
  schedule();
}

function schedule(delay = DEBOUNCE_MS) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void runSweep();
  }, delay);
  state.timer.unref?.();
}

async function readLastFull(): Promise<number | null> {
  if (state.lastFullAt !== null) return state.lastFullAt;
  const row = await db.meta.findUnique({ where: { key: META_LAST_FULL } });
  state.lastFullAt = row ? Number(row.value) : null;
  return state.lastFullAt;
}

/** After warm-up: a full sweep if new embeddings landed since the last one. */
async function onWarmed() {
  try {
    const [last, embedded] = await Promise.all([readLastFull(), ml.lastEmbeddingAt()]);
    if (embedded && (last === null || embedded.getTime() > last)) state.full = true;
  } catch (error) {
    console.error("[sweep] staleness check failed:", error);
  }
  if (state.full || state.dirty.size) schedule(0);
}

/** Process queued work until none is left. Single-flight; safe to call anytime. */
export function runSweep(): Promise<void> {
  if (state.running) return state.running;
  const pending = (async () => {
    while (state.full || state.dirty.size) {
      if (!ml.mlIdle() || !(await ml.isReady())) return; // the next warm-up re-triggers
      await ml.enqueueTagVectors(); // classifiers/vectors for the work below
      if (!ml.mlIdle()) return;
      const full = state.full;
      const dirty = [...state.dirty];
      state.full = false;
      state.dirty.clear();
      state.current = full ? "all" : new Set(dirty);
      const startedAt = Date.now();
      try {
        await sweepTags(full ? null : dirty);
        state.error = undefined;
      } catch (error) {
        // put the work back; a later trigger retries
        if (full) state.full = true;
        else for (const t of dirty) state.dirty.add(t);
        state.error = error instanceof Error ? error.message : String(error);
        if (!(error instanceof ml.SidecarError)) console.error("[sweep] failed:", error);
        return;
      }
      if (full) {
        state.lastFullAt = startedAt;
        await db.meta.upsert({
          where: { key: META_LAST_FULL },
          create: { key: META_LAST_FULL, value: String(startedAt) },
          update: { value: String(startedAt) },
        });
      }
    }
  })().finally(() => {
    state.running = null;
    state.progress = null;
    state.current = null;
  });
  state.running = pending;
  return pending;
}

/** Sweep the named tags (null = all tags with enough images). */
async function sweepTags(names: string[] | null) {
  const counts = new Map((await tree()).map((n) => [n.name, n.count]));
  const tags = await db.tag.findMany({ select: { id: true, name: true } });
  const byName = new Map(tags.map((t) => [t.name, t]));
  const wanted = names === null ? tags : names.map((n) => byName.get(n)).filter((t) => t !== undefined);

  // too few images → no calibration; clear any stale inbox rows
  const small = wanted.filter((t) => (counts.get(t.name) ?? 0) < MIN_POSITIVES);
  if (small.length) await clearTags(small.map((t) => t.id));
  const targets = wanted.filter((t) => (counts.get(t.name) ?? 0) >= MIN_POSITIVES);
  if (targets.length === 0) return;

  const models = await ml.cachedTagModels();
  const siblingsOf = new Map<string, string[]>();
  for (const t of tags) {
    const parent = ml.parentOf(t.name);
    if (parent) siblingsOf.set(parent, [...(siblingsOf.get(parent) ?? []), t.name]);
  }

  state.progress = { done: 0, total: targets.length };
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const include = new Set<string>();
    for (const t of batch) {
      include.add(t.name);
      const parent = ml.parentOf(t.name);
      for (const s of parent ? siblingsOf.get(parent) ?? [] : []) include.add(s);
    }
    const payload = [...include].flatMap((name) => {
      const tag = byName.get(name);
      const m = tag && models.get(tag.id);
      return m ? [{ name, w: m.w, b: m.b }] : [];
    });
    const results = await ml.sweepSidecar(batch.map((t) => t.name), payload);
    await writeResults(results, byName);
    state.progress = { done: Math.min(i + BATCH, targets.length), total: targets.length };
  }
}

async function clearTags(tagIds: number[]) {
  await db.tagCandidate.deleteMany({ where: { tagId: { in: tagIds } } });
  await db.tagSweep.deleteMany({ where: { tagId: { in: tagIds } } });
}

async function writeResults(results: ml.SweepResult[], byName: Map<string, { id: number; name: string }>) {
  const sweptAt = new Date();
  for (const r of results) {
    const tag = byName.get(r.tag);
    if (!tag) continue;
    if (r.skipped) {
      await clearTags([tag.id]);
      continue;
    }
    // A file may have been deleted mid-sweep; only keep rows whose file still exists.
    const ids = r.pool.filter((p) => p.confidence >= KEEP_FLOOR).map((p) => p.fileId);
    const live = new Set((await db.file.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((f) => f.id));
    const rows = r.pool
      .filter((p) => p.confidence >= KEEP_FLOOR && live.has(p.fileId))
      .map((p) => ({
        tagId: tag.id,
        fileId: p.fileId,
        confidence: p.confidence,
        score: p.score,
        mode: p.mode,
        rank: p.rank,
        rivalTag: p.rival?.tag ?? null,
        rivalConfidence: p.rival?.confidence ?? null,
        nearDenial: p.nearDenial,
        sweptAt,
      }));
    const summary = { positives: r.positives, modes: r.modes, exemplars: JSON.stringify(r.exemplars), sweptAt };
    await db.$transaction([
      db.tagCandidate.deleteMany({ where: { tagId: tag.id } }),
      db.tagCandidate.createMany({ data: rows }),
      db.tagSweep.upsert({ where: { tagId: tag.id }, create: { tagId: tag.id, ...summary }, update: summary }),
    ]);
  }
}
