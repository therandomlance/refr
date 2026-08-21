import "server-only";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { db } from "refr/server/db";
import * as config from "./config";
import { paths } from "./dataDir";
import { thumbPath, hasThumb } from "./thumbs";

const execFileP = promisify(execFile);

const ML_DIR = path.resolve(process.cwd(), "ml");
const DIM = 768;

/** Float32Array → owned bytes for Prisma Bytes columns. */
function vecToBytes(v: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(v.byteLength);
  out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  return out;
}

export type MlStatus = {
  enabled: boolean;
  state: "disabled" | "bootstrapping" | "starting" | "ready" | "error";
  device?: string;
  model?: string;
  embedded: number;
  total: number;
  log: string[];
  error?: string;
};

let state: MlStatus["state"] = "disabled";
let bootLog: string[] = [];
let lastError: string | undefined;
let child: ChildProcess | null = null;
let healthInfo: { device?: string; model?: string } = {};
let restarts = 0;
let stopping = false;

// Kill the sidecar when the Node process exits so it doesn't orphan and squat
// on the port (which would make the next server start think ML is "ready" from
// the stale /health response while POSTs silently fail).
process.on("exit", () => {
  if (child) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
});

function log(line: string) {
  bootLog.push(line);
  if (bootLog.length > 200) bootLog.shift();
}

export async function status(): Promise<MlStatus> {
  const cfg = config.get().ml;
  const total = await db.file.count();
  const embedded = await db.fileEmbedding.count();
  if (!cfg.enabled) {
    return { enabled: false, state: "disabled", embedded, total, log: bootLog.slice(-50) };
  }
  // The sidecar may have been started by another module graph (boot via
  // instrumentation), so trust the live /health over this graph's local state;
  // local state still covers bootstrapping/error while it's coming up here.
  const h = await health();
  const live: MlStatus["state"] = h
    ? h.status === "ready"
      ? "ready"
      : "starting"
    : state === "disabled"
      ? "starting"
      : state;
  return {
    enabled: true,
    state: live,
    device: h?.device ?? healthInfo.device,
    model: h?.model ?? healthInfo.model,
    embedded,
    total,
    log: bootLog.slice(-50),
    error: live === "error" ? lastError : undefined,
  };
}

async function pythonBin(): Promise<string> {
  return path.join(paths.mlVenv, "bin", "python");
}

async function validatePython(): Promise<string> {
  for (const cmd of ["python3", "python"]) {
    try {
      const { stdout } = await execFileP(cmd, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]);
      const [maj, min] = stdout.trim().split(".").map(Number);
      if ((maj ?? 0) >= 3 && (min ?? 0) >= 10) return cmd;
    } catch {
      // try next
    }
  }
  throw new Error("python ≥ 3.10 not found on PATH");
}

async function ensureVenv(onProgress?: () => void) {
  const py = await pythonBin();
  if (fs.existsSync(py)) return;
  const sysPython = await validatePython();
  log("creating venv…");
  await execFileP(sysPython, ["-m", "venv", paths.mlVenv]);
  log("installing dependencies (this downloads several GB on first run)…");
  const pip = path.join(paths.mlVenv, "bin", "pip");
  const install = spawn(pip, ["install", "-r", path.join(ML_DIR, "requirements.txt")]);
  install.stdout.on("data", (d: Buffer) => log(d.toString().trim()));
  install.stderr.on("data", (d: Buffer) => log(d.toString().trim()));
  await new Promise<void>((resolve, reject) => {
    install.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pip exited ${code}`))));
  });
  log("dependencies installed");
  onProgress?.();
}

function spawnSidecar() {
  const cfg = config.get().ml;
  const args = [
    path.join(ML_DIR, "server.py"),
    "--db", paths.db,
    "--thumbs", paths.thumbnails,
    "--port", String(cfg.port),
    "--model", cfg.model,
    "--pretrained", cfg.pretrained,
  ];
  return new Promise<ChildProcess>((resolve, reject) => {
    void pythonBin().then((py) => {
      const c = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"] });
      c.stdout?.on("data", (d: Buffer) => log(d.toString().trim()));
      c.stderr?.on("data", (d: Buffer) => log(d.toString().trim()));
      c.on("spawn", () => resolve(c));
      c.on("error", reject);
    }, reject);
  });
}

async function waitReady(timeoutMs = 600_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health();
    if (h?.status === "ready") {
      healthInfo = { device: h.device, model: h.model };
      return true;
    }
    if (child?.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function health(): Promise<{ status: string; device?: string; model?: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.get().ml.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return (await res.json()) as { status: string; device?: string; model?: string };
  } catch {
    return null;
  }
}

// The sidecar is booted from instrumentation — a separate module graph from
// route handlers — so the module-local `state` is "disabled" in the handler
// graph even when the sidecar is healthy. Trust the live /health instead, with
// a short TTL cache so tight loops (refreshTagVectors) don't hammer it.
let healthCache: { ready: boolean; t: number } | null = null;
const HEALTH_TTL = 3000;

async function isReady(): Promise<boolean> {
  if (!config.get().ml.enabled) return false;
  const now = Date.now();
  // Only cache positive results — caching "not ready" would stall
  // enqueueEmbeddings right after the sidecar comes up (waitReady polls
  // health() directly, bypassing this cache, so the cache can hold a stale
  // false from the loading phase).
  if (healthCache?.ready && now - healthCache.t < HEALTH_TTL) return true;
  const h = await health();
  const ready = h?.status === "ready";
  healthCache = { ready, t: now };
  if (ready) state = "ready";
  return ready;
}

/** Quick POST to verify the sidecar is actually functional (not just /health). */
async function probeSidecar(): Promise<boolean> {
  try {
    await post("/embed/text", { texts: ["probe"] });
    return true;
  } catch {
    return false;
  }
}

/** Kill whatever process is squatting on a port (stale sidecar from a crashed
 *  previous server). Linux-only; no-op if lsof isn't available. */
async function killPort(port: number): Promise<void> {
  try {
    await execFileP("bash", ["-c", `lsof -ti tcp:${port} | xargs -r kill -9`]);
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // lsof missing or no process — not fatal
  }
}

async function start() {
  stopping = false;
  state = "bootstrapping";
  bootLog = [];
  lastError = undefined;
  try {
    // Reuse a healthy, functional sidecar from a previous session if one is
    // already on the port — avoids a multi-minute model reload on dev restarts.
    const h = await health();
    if (h?.status === "ready" && h.model === currentModelId()) {
      if (await probeSidecar()) {
        state = "ready";
        healthInfo = { device: h.device, model: h.model };
        restarts = 0;
        log("reusing existing sidecar");
        void enqueueEmbeddings();
        return;
      }
      // Stale sidecar responds to /health but POSTs fail (orphaned process from
      // a crashed/killed previous server). Evict it before spawning our own.
      log("evicting stale sidecar on port…");
      await killPort(config.get().ml.port);
    }

    await ensureVenv();
    state = "starting";
    log("starting sidecar…");
    child = await spawnSidecar();
    child.on("exit", (code) => {
      child = null;
      if (stopping || !config.get().ml.enabled) return;
      state = "error";
      lastError = `sidecar exited (${code})`;
      if (restarts < 3) {
        restarts++;
        log(`restarting sidecar (attempt ${restarts}/3)…`);
        setTimeout(() => void start(), 2000 * restarts);
      }
    });
    const ok = await waitReady();
    // Verify OUR child is still alive AND functional — a stale sidecar on the
    // port can answer /health before the new child crashes on bind, making
    // waitReady return true for the wrong process. The POST probe catches this.
    if (ok && child?.exitCode === null && (await probeSidecar())) {
      state = "ready";
      restarts = 0;
      log("sidecar ready");
      void enqueueEmbeddings();
    } else {
      state = "error";
      lastError = ok
        ? "sidecar health check passed but POST failed — port may be in use by a stale process"
        : "sidecar did not become ready";
      log(`error: ${lastError}`);
      child?.kill();
      child = null;
    }
  } catch (e) {
    state = "error";
    lastError = e instanceof Error ? e.message : String(e);
    log(`error: ${lastError}`);
  }
}

function stop() {
  stopping = true;
  child?.kill();
  child = null;
  state = "disabled";
  healthInfo = {};
}

export async function setEnabled(enabled: boolean) {
  config.patch({ ml: { enabled } });
  if (enabled) {
    void start(); // bootstrap is long; status() polls progress
  } else {
    stop();
  }
  return status();
}

/** Called at server boot. */
export async function bootMl() {
  if (config.get().ml.enabled) void start();
}

// ---------------------------------------------------------------- embeddings

let embedRunning = false;

/** Background: embed files lacking a current-model embedding, batches of 8 thumbnails. */
export async function enqueueEmbeddings() {
  if (!config.get().ml.enabled || !(await isReady()) || embedRunning) return;
  embedRunning = true;
  try {
    const modelId = currentModelId();
    // ponytail: keyset-page by f.id so a run of thumbless files can't stall the
    // queue — they're skipped (continue), not aborted. Next boot retries them
    // once their thumbnails exist. Batch is small (8) so search requests
    // interleave with embedding batches at the sidecar.
    let cursor = "";
    for (;;) {
      if (!(await isReady())) return;
      const batch = await db.$queryRawUnsafe<{ fileId: string }[]>(
        `SELECT f.id AS fileId FROM File f
         LEFT JOIN FileEmbedding fe ON fe.fileId = f.id AND fe.model = ?
         WHERE fe.fileId IS NULL AND f.id > ?
         ORDER BY f.id LIMIT 8`,
        modelId,
        cursor,
      );
      if (batch.length === 0) return;
      cursor = batch[batch.length - 1]!.fileId;
      const withThumbs = batch.filter((b) => hasThumb(b.fileId));
      if (withThumbs.length === 0) continue;
      try {
        const vectors = await embedImages(withThumbs.map((b) => thumbPath(b.fileId)));
        for (let i = 0; i < withThumbs.length; i++) {
          await db.fileEmbedding.upsert({
            where: { fileId: withThumbs[i]!.fileId },
            create: { fileId: withThumbs[i]!.fileId, vector: vecToBytes(vectors[i]!), model: modelId },
            update: { vector: vecToBytes(vectors[i]!), model: modelId },
          });
        }
      } catch {
        return; // sidecar hiccup — next scan/boot retries
      }
    }
  } finally {
    embedRunning = false;
  }
}

function currentModelId(): string {
  const cfg = config.get().ml;
  return `${cfg.model}__${cfg.pretrained}`;
}

/** ponytail: test hook — lets vitest fake "ready" without a real sidecar process. */
export function _setStateForTest(s: MlStatus["state"]) {
  state = s;
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${config.get().ml.port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`sidecar ${endpoint}: ${res.status}`);
  return (await res.json()) as T;
}

export async function embedText(texts: string[]): Promise<Float32Array[]> {
  const r = await post<{ vectors: number[][] }>("/embed/text", { texts });
  return r.vectors.map((v) => Float32Array.from(v));
}

async function embedImages(imagePaths: string[]): Promise<Float32Array[]> {
  const r = await post<{ vectors: number[][] }>("/embed/image", { paths: imagePaths });
  return r.vectors.map((v) => Float32Array.from(v));
}

export async function knn(
  vector: Float32Array,
  k: number,
  skip = 0,
  excludeTag?: string,
  excludeIds?: string[],
): Promise<{ fileId: string; score: number }[]> {
  return post("/knn", {
    vector: Array.from(vector),
    k,
    skip,
    ...(excludeTag ? { excludeTag } : {}),
    ...(excludeIds?.length ? { excludeIds } : {}),
  });
}

export async function fileVector(fileId: string): Promise<Float32Array | null> {
  const row = await db.fileEmbedding.findUnique({
    where: { fileId },
    select: { vector: true, model: true },
  });
  if (row?.model === currentModelId()) {
    return new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.length / 4);
  }
  // on-demand single embed for unembedded files (§13.6: allowed in request path)
  if (!(await isReady()) || !hasThumb(fileId)) return null;
  const [v] = await embedImages([thumbPath(fileId)]);
  if (!v) return null;
  await db.fileEmbedding.upsert({
    where: { fileId },
    create: { fileId, vector: vecToBytes(v), model: currentModelId() },
    update: { vector: vecToBytes(v), model: currentModelId() },
  });
  return v;
}

export async function similar(fileId: string): Promise<{ fileId: string; score: number }[]> {
  const v = await fileVector(fileId);
  if (!v) return [];
  const r = await knn(v, 201);
  return r.filter((x) => x.fileId !== fileId).slice(0, 200);
}

// ---------------------------------------------------------------- suggestion exclusions

async function getExclusions(tagName: string): Promise<Set<string>> {
  const rows = await db.suggestionDenial.findMany({ where: { tagName }, select: { fileId: true } });
  return new Set(rows.map((r) => r.fileId));
}

export async function excludeSuggestion(tagName: string, fileId: string) {
  await db.suggestionDenial.upsert({
    where: { tagName_fileId: { tagName, fileId } },
    create: { tagName, fileId },
    update: {},
  });
}

// ---------------------------------------------------------------- tag vectors

export async function bumpLinksVersion() {
  const row = await db.meta.findUnique({ where: { key: "linksVersion" } });
  await db.meta.upsert({
    where: { key: "linksVersion" },
    create: { key: "linksVersion", value: "1" },
    update: { value: String(Number(row?.value ?? "0") + 1) },
  });
}

async function linksVersion(): Promise<number> {
  const row = await db.meta.findUnique({ where: { key: "linksVersion" } });
  return Number(row?.value ?? "0");
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

function prettify(tag: string): string {
  return tag.split("/").join(" ");
}

/** All path prefixes of a tag name, including itself. */
function ancestors(name: string): string[] {
  const parts = name.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Parent tag of a hierarchical name, or null for a top-level tag. */
function parentOf(name: string): string | null {
  const i = name.lastIndexOf("/");
  return i <= 0 ? null : name.slice(0, i);
}

/** §13.4: v = normalize(w_text·textEmb(tag) + w_img·centroid(images)); cold start = textEmb. */
async function computeTagVector(
  tagName: string,
  textEmb: Float32Array,
): Promise<{ v: Float32Array; fileCount: number }> {
  const samples = await db.$queryRawUnsafe<{ vector: Buffer }[]>(
    `SELECT fe.vector FROM FileEmbedding fe
     WHERE fe.model = ? AND fe.fileId IN (
       SELECT ft.fileId FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
       WHERE t.name = ? OR t.name LIKE ? ESCAPE '\\'
     )
     ORDER BY RANDOM() LIMIT 2000`,
    currentModelId(),
    tagName,
    `${tagName.replace(/[%_\\]/g, (c) => "\\" + c)}/%`,
  );

  const fileCount = samples.length;
  if (fileCount === 0) return { v: textEmb, fileCount }; // cold start
  const wText = config.get().ml.tagSuggestionTextWeight;
  const centroid = new Float32Array(DIM);
  for (const s of samples) {
    const sv = new Float32Array(s.vector.buffer, s.vector.byteOffset, s.vector.length / 4);
    for (let i = 0; i < DIM; i++) centroid[i]! += sv[i]!;
  }
  for (let i = 0; i < DIM; i++) centroid[i]! /= fileCount;
  const combined = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) combined[i] = wText * textEmb[i]! + (1 - wText) * centroid[i]!;
  return { v: normalize(combined), fileCount };
}

/** Cached tag vector keyed by tagId; invalidated by linksVersion + model. */
export async function tagVector(tagId: number): Promise<Float32Array | null> {
  const tag = await db.tag.findUnique({ where: { id: tagId }, select: { name: true } });
  if (!tag) return null;
  const lv = await linksVersion();
  const modelId = currentModelId();
  const cached = await db.tagVector.findUnique({ where: { tagId } });
  if (cached?.linksVersion === lv && cached.model === modelId) {
    return new Float32Array(cached.vector.buffer, cached.vector.byteOffset, cached.vector.length / 4);
  }
  if (!(await isReady())) return null;
  const [textEmb] = await embedText([prettify(tag.name)]);
  if (!textEmb) return null;
  const { v, fileCount } = await computeTagVector(tag.name, textEmb);
  await db.tagVector.upsert({
    where: { tagId },
    create: { tagId, vector: vecToBytes(v), fileCount, linksVersion: lv, model: modelId },
    update: { vector: vecToBytes(v), fileCount, linksVersion: lv, model: modelId },
  });
  return v;
}

/** Uncached tag vector by name — for prefix tree nodes with no Tag row (§13.7). */
async function computeTagVectorByName(tagName: string): Promise<Float32Array | null> {
  if (!(await isReady())) return null;
  const [textEmb] = await embedText([prettify(tagName)]);
  if (!textEmb) return null;
  const { v } = await computeTagVector(tagName, textEmb);
  return v;
}

/** Batch-rebuild TagVector rows (one text-embed call for all tags). */
async function refreshTagVectors() {
  const lv = await linksVersion();
  const modelId = currentModelId();
  const tags = await db.tag.findMany({ select: { id: true, name: true }, take: 500 });
  if (tags.length === 0) return;
  const textEmbs = await embedText(tags.map((t) => prettify(t.name)));
  for (let i = 0; i < tags.length; i++) {
    const textEmb = textEmbs[i]!;
    if (!textEmb) continue;
    const { v, fileCount } = await computeTagVector(tags[i]!.name, textEmb);
    await db.tagVector.upsert({
      where: { tagId: tags[i]!.id },
      create: { tagId: tags[i]!.id, vector: vecToBytes(v), fileCount, linksVersion: lv, model: modelId },
      update: { vector: vecToBytes(v), fileCount, linksVersion: lv, model: modelId },
    });
  }
}

/** Suggested images for a tag: kNN on the tag vector, excluding files already tagged
 *  or manually excluded via the ✕ button. */
export async function suggestImagesForTag(tagName: string) {
  if (!(await isReady())) return [];
  const tag = await db.tag.findUnique({ where: { name: tagName }, select: { id: true } });
  const v = tag ? await tagVector(tag.id) : await computeTagVectorByName(tagName);
  if (!v) return [];
  const excluded = await getExclusions(tagName);
  return knn(v, 60, 0, tagName, excluded.size ? [...excluded] : undefined);
}

/** Suggested images for a tag, limited to files carrying the bare parent tag
 *  but no descendant of the parent (images sitting at the parent level, not
 *  yet sub-categorized under T or any sibling). Ranked by similarity to T's
 *  vector. Same ✕ exclusion set as the main strip.
 *  ponytail: Node-side dot-product over the bare-parent candidate set. Fine
 *  up to ~10k such files; at scale, push an includeIds filter into the sidecar
 *  /knn (which currently only supports excludeIds). */
export async function suggestImagesWithinParent(tagName: string) {
  const parent = parentOf(tagName);
  if (!parent) return [];
  if (!(await isReady())) return [];
  const tag = await db.tag.findUnique({ where: { name: tagName }, select: { id: true } });
  const v = tag ? await tagVector(tag.id) : await computeTagVectorByName(tagName);
  if (!v) return [];
  const esc = parent.replace(/[\\%_]/g, (c) => "\\" + c);
  const rows = await db.$queryRawUnsafe<{ fileId: string; vector: Buffer }[]>(
    `SELECT fe.fileId AS fileId, fe.vector
     FROM FileEmbedding fe
     WHERE fe.model = ? AND fe.fileId IN (
       SELECT ft.fileId FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
       WHERE t.name = ?
         AND NOT EXISTS (
           SELECT 1 FROM FileTag ft2 JOIN Tag t2 ON t2.id = ft2.tagId
           WHERE ft2.fileId = ft.fileId AND t2.name LIKE ? ESCAPE '\\'
         )
     )`,
    currentModelId(),
    parent,
    esc + "/%",
  );
  if (rows.length === 0) return [];
  const excluded = await getExclusions(tagName);
  const scored = rows
    .filter((r) => !excluded.has(r.fileId))
    .map((r) => {
      const sv = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.length / 4);
      let score = 0;
      for (let i = 0; i < DIM; i++) score += v[i]! * sv[i]!;
      return { fileId: r.fileId, score };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 60);
}

/** Suggested tags for a file: file vector vs TagVector matrix, top 5. */
export async function suggestTagsForFile(fileId: string): Promise<{ tag: string; score: number }[]> {
  if (!(await isReady())) return [];
  const v = await fileVector(fileId);
  if (!v) return [];
  const lv = await linksVersion();
  const modelId = currentModelId();
  const stale = await db.tagVector.count({
    where: { OR: [{ linksVersion: { not: lv } }, { model: { not: modelId } }] },
  });
  let rows = await db.tagVector.findMany({ include: { tag: { select: { name: true } } } });
  if (stale > 0 || rows.length === 0) {
    try {
      await refreshTagVectors();
      rows = await db.tagVector.findMany({ include: { tag: { select: { name: true } } } });
    } catch {
      return [];
    }
  }
  const existing = await db.fileTag.findMany({
    where: { fileId },
    select: { tag: { select: { name: true } } },
  });
  // exclude existing tags AND their ancestors — a specific tag implies its parents
  const excludeNames = new Set<string>();
  for (const e of existing) {
    for (const a of ancestors(e.tag.name)) excludeNames.add(a);
  }
  const scored: { tag: string; score: number }[] = [];
  for (const r of rows) {
    if (excludeNames.has(r.tag.name)) continue;
    const tv = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.length / 4);
    let score = 0;
    for (let i = 0; i < DIM; i++) score += v[i]! * tv[i]!;
    scored.push({ tag: r.tag.name, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

export async function reembedAll() {
  await db.fileEmbedding.deleteMany({});
  await db.tagVector.deleteMany({});
  await enqueueEmbeddings();
}
