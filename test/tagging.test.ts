import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import YAML from "yaml";
import { db } from "refr/server/db";
import * as config from "refr/server/services/config";
import { paths } from "refr/server/services/dataDir";
import * as ml from "refr/server/services/ml";
import { setTags } from "refr/server/services/tags";
import { registerSweepHooks, requestSweep, runSweep, sweepStatus } from "refr/server/services/sweep";
import * as tagging from "refr/server/services/tagging";

// deterministic test vectors (same scheme as ml.test.ts)
function vec(seed: number): number[] {
  const v = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}
const mlModel = () => `${config.get().ml.model}__${config.get().ml.pretrained}`;

const A = "tgchars/a";
const B = "tgchars/b";
const pos = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const aFiles = pos("tg-a", 6);
const bFiles = pos("tg-b", 5);
const cands = pos("tg-c", 6);

type SweepReq = { targets: string[]; models: { name: string; w: string; b: number }[] };
const sweepRequests: SweepReq[] = [];
const trainRequests: { tag: string; siblingNegatives?: number }[] = [];

function poolFor(tag: string) {
  if (tag !== A) return null;
  const p = (fileId: string, confidence: number, extra: object = {}) =>
    ({ fileId, score: confidence, confidence, mode: 0, rank: 0, rival: null, nearDenial: false, ...extra });
  return {
    tag, positives: 6, modes: 2, exemplars: [[aFiles[0], aFiles[1]], [aFiles[2]]],
    pool: [
      p(cands[0]!, 0.9, { rank: 0 }),
      p(cands[1]!, 0.8, { rank: 1, rival: { tag: B, confidence: 0.85 } }),
      p(cands[2]!, 0.7, { rank: 2, nearDenial: true }),
      p(cands[3]!, 0.3, { rank: 3 }),
      p(cands[4]!, 0.05, { rank: 4 }), // below the keep floor — not stored
      p(cands[5]!, 0.65, { rank: 5, mode: 1 }),
      p(aFiles[0]!, 0.99, { rank: 6 }), // an already-tagged file must never come back
    ],
  };
}

const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}") as { texts?: string[] };
    if (req.url === "/health") res.end(JSON.stringify({ status: "ready", device: "cpu", model: mlModel() }));
    else if (req.url === "/embed/text") res.end(JSON.stringify({ vectors: (parsed.texts ?? []).map((t) => vec(t.length % 97)) }));
    else if (req.url === "/train") {
      trainRequests.push(parsed as unknown as { tag: string });
      res.end(JSON.stringify({ weights: null, bias: null, positives: 1, negatives: 0 }));
    } else if (req.url === "/sweep") {
      const r = parsed as unknown as SweepReq;
      sweepRequests.push(r);
      res.end(JSON.stringify({ results: r.targets.map((t) => poolFor(t) ?? { tag: t, skipped: true }) }));
    } else if (req.url === "/knn") res.end("[]");
    else {
      res.statusCode = 404;
      res.end();
    }
  });
});

describe("tag-model config migration", () => {
  it("maps the legacy ml.tagClassifier boolean to tagModel: auto", () => {
    config.get(); // creates config.yaml on first use
    const original = fs.readFileSync(paths.config, "utf8");
    try {
      const raw = YAML.parse(original) as { ml?: Record<string, unknown> };
      raw.ml = { ...(raw.ml ?? {}), tagClassifier: false };
      delete raw.ml.tagModel;
      fs.writeFileSync(paths.config, YAML.stringify(raw));
      const fresh = new Date(Date.now() + 5000);
      fs.utimesSync(paths.config, fresh, fresh); // force a re-read
      const ml = config.get().ml as Record<string, unknown>;
      expect(ml.tagModel).toBe("auto");
      expect("tagClassifier" in ml).toBe(false);
    } finally {
      fs.writeFileSync(paths.config, original);
      const later = new Date(Date.now() + 10000);
      fs.utimesSync(paths.config, later, later);
      config.get();
    }
  });
});

describe("tagging inbox (stub sidecar)", () => {
  beforeAll(async () => {
    await new Promise<void>((r) => stub.listen(0, r));
    config.patch({ ml: { enabled: true, port: (stub.address() as { port: number }).port, tagModel: "auto" } });
    ml._setStateForTest("ready");
    const all = [...aFiles, ...bFiles, ...cands];
    await db.file.createMany({ data: all.map((id) => ({ id, size: 1, mtime: new Date(), mediaType: "image" })) });
    await db.fileEmbedding.createMany({
      data: all.map((id, i) => ({ fileId: id, vector: Buffer.from(new Float32Array(vec(100 + i)).buffer), model: mlModel() })),
    });
    await setTags(aFiles, [A], []);
    await setTags(bFiles, [B], []);
  });
  afterAll(async () => {
    ml.setSweepHooks(undefined);
    await ml.enqueueTagVectors();
    config.patch({ ml: { enabled: false } });
    stub.close();
  });

  it("sweeps a tag: stores calibrated candidates, sends sibling models, trains with sibling negatives", async () => {
    requestSweep({ tags: [A] });
    await runSweep();
    expect(sweepStatus().error).toBeUndefined();
    const req = sweepRequests.find((r) => r.targets.includes(A));
    expect(req).toBeDefined();
    expect(req!.models.map((m) => m.name).sort()).toEqual([A, B]); // sibling included for rival checks
    expect(Buffer.from(req!.models[0]!.w, "base64").length).toBe(768 * 4);
    expect(trainRequests.some((r) => r.tag === A && r.siblingNegatives === 1000)).toBe(true);

    const tag = await db.tag.findUniqueOrThrow({ where: { name: A } });
    const rows = await db.tagCandidate.findMany({ where: { tagId: tag.id } });
    expect(rows.map((r) => r.fileId).sort()).toEqual([aFiles[0], cands[0], cands[1], cands[2], cands[3], cands[5]].sort());
    const sweep = await db.tagSweep.findUniqueOrThrow({ where: { tagId: tag.id } });
    expect(sweep.modes).toBe(2);
  });

  it("overview counts ready / flagged / uncertain at a threshold", async () => {
    const { tags } = await tagging.overview(0.6);
    const a = tags.find((t) => t.tag === A);
    // cands 0 + 5 ready; 1 (rival) + 2 (near denial) flagged; 3 uncertain; the stale aFiles[0] row counts until re-swept
    expect(a).toMatchObject({ ready: 3, flagged: 2, uncertain: 1, positives: 6 });
    expect((await tagging.overview(0.95)).tags.find((t) => t.tag === A)).toMatchObject({ ready: 1, uncertain: 5 });
  });

  it("batch: default states, rank order, live filtering of tagged files, uncertain band, session skips", async () => {
    const b = await tagging.batch({ tag: A, minConfidence: 0.6, size: 40, includeUncertain: false, exclude: [] });
    expect(b.candidates.map((c) => c.fileId)).toEqual([cands[0], cands[1], cands[2], cands[5]]); // not aFiles[0]
    expect(b.candidates.map((c) => c.defaultState)).toEqual(["accept", "skip", "skip", "accept"]);
    expect(b.candidates[1]!.rival).toEqual({ tag: B, confidence: 0.85 });
    expect(b.exemplars).toEqual([[aFiles[0], aFiles[1]], [aFiles[2]]]);

    const withUncertain = await tagging.batch({ tag: A, minConfidence: 0.6, size: 40, includeUncertain: true, exclude: [cands[0]!] });
    expect(withUncertain.candidates.map((c) => c.fileId)).toEqual([cands[1], cands[2], cands[5], cands[3]]);
    expect(withUncertain.candidates.at(-1)).toMatchObject({ uncertain: true, defaultState: "skip" });
  });

  it("a tag added elsewhere drops the candidate row immediately", async () => {
    await setTags([cands[5]!], [`${A}/outfit`], []); // a descendant also fulfils the parent
    const tag = await db.tag.findUniqueOrThrow({ where: { name: A } });
    expect(await db.tagCandidate.findUnique({ where: { tagId_fileId: { tagId: tag.id, fileId: cands[5]! } } })).toBeNull();
    await setTags([cands[5]!], [], [`${A}/outfit`]);
  });

  it("commit: accepts tag, rejects become denials, reassign tags the rival and denies here; undo reverts all", async () => {
    registerSweepHooks();
    const result = await tagging.commit({ tag: A, accept: [cands[0]!], deny: [cands[2]!], reassign: [{ tag: B, fileIds: [cands[1]!] }] });
    const names = async (id: string) => (await db.fileTag.findMany({ where: { fileId: id }, include: { tag: true } })).map((t) => t.tag.name);
    expect(await names(cands[0]!)).toEqual([A]);
    expect(await names(cands[1]!)).toEqual([B]);
    expect((await ml.getExclusions(A))).toEqual(new Set([cands[2], cands[1]]));
    expect(result.denied.map((d) => d.fileId).sort()).toEqual([cands[1], cands[2]].sort());
    const tag = await db.tag.findUniqueOrThrow({ where: { name: A } });
    expect(await db.tagCandidate.count({ where: { tagId: tag.id, fileId: { in: [cands[0]!, cands[1]!, cands[2]!] } } })).toBe(0);
    expect(sweepStatus().pending).toBeGreaterThan(0); // the touched tags re-sweep

    await tagging.undo(result);
    expect(await names(cands[0]!)).toEqual([]);
    expect(await names(cands[1]!)).toEqual([]);
    expect((await ml.getExclusions(A)).size).toBe(0);
  });

  it("commitFiles accepts and rejects per file; byFile pages newest first", async () => {
    requestSweep({ tags: [A] });
    await runSweep();
    const page = await tagging.byFile({ minConfidence: 0.6, cursor: null, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const p = await tagging.byFile({ minConfidence: 0.6, cursor, limit: 1 });
      all.push(...p.items.map((i) => i.fileId));
      cursor = p.nextCursor;
    } while (cursor);
    expect(all).toEqual(expect.arrayContaining([cands[0], cands[5]]));
    expect(new Set(all).size).toBe(all.length);

    const r = await tagging.commitFiles([{ fileId: cands[0]!, accept: [A], deny: [] }, { fileId: cands[5]!, accept: [], deny: [A] }]);
    expect(r.changes.map((c) => c.fileId)).toEqual([cands[0]]);
    expect(r.denied).toEqual([{ tag: A, fileId: cands[5] }]);
    await tagging.undo(r);
  });
});
