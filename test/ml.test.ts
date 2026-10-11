import { describe, expect, it, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { db } from "refr/server/db";
import * as config from "refr/server/services/config";
import * as ml from "refr/server/services/ml";
import { semanticSearch, vectorSearch } from "refr/server/services/semantic";
import { setTags } from "refr/server/services/tags";
import { makeToken } from "refr/server/services/search";
import { thumbPath } from "refr/server/services/thumbs";

// deterministic test vectors
function vec(seed: number): number[] {
  const v = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

let holdImages = false;
let releaseImages: (() => void) | undefined;
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}") as { texts?: string[]; paths?: string[] };
    if (req.url === "/health") {
      res.end(JSON.stringify({ status: "ready", device: "cpu", model: "test" }));
    } else if (req.url === "/embed/text") {
      res.end(JSON.stringify({ vectors: (parsed.texts ?? []).map((t) => vec(t.length % 97)) }));
    } else if (req.url === "/embed/image") {
      const paths = parsed.paths ?? [];
      const reply = () => res.end(JSON.stringify({ vectors: paths.map((p) => vec(p.length % 97)), kept: paths.map((_, i) => i) }));
      if (holdImages) releaseImages = reply;
      else reply();
    } else if (req.url === "/knn") {
      res.end(JSON.stringify([]));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
});

function portOf(server: http.Server): number {
  return (server.address() as { port: number }).port;
}

describe("ml (stub sidecar)", () => {
  it("setup stub + enable", async () => {
    await new Promise<void>((r) => stub.listen(0, r));
    config.patch({ ml: { enabled: true, port: portOf(stub) } });
    ml._setStateForTest("ready");

    await db.file.create({ data: { id: "ml1", size: 1, mtime: new Date(), mediaType: "image" } });
    await setTags(["ml1"], ["mltag"], []);
  });
  afterAll(() => stub.close());

  it("reports actual embedding activity, not incomplete coverage", async () => {
    const ids = ["ml-progress-ready", "ml-progress-no-thumb", "ml-progress-old-model"];
    await db.file.createMany({ data: ids.map((id) => ({ id, size: 1, mtime: new Date(), mediaType: "image" })) });
    await db.fileEmbedding.create({ data: { fileId: ids[2]!, vector: Buffer.from(new Float32Array(vec(1)).buffer), model: "old-model" } });
    const before = await ml.status();
    expect(before.embeddingRunning).toBe(false);
    expect(before.embedded).toBe(await db.fileEmbedding.count({ where: { model: mlModel() } }));

    const thumb = thumbPath(ids[0]!);
    fs.mkdirSync(path.dirname(thumb), { recursive: true });
    fs.writeFileSync(thumb, "stub thumbnail");
    holdImages = true;
    const run = ml.enqueueEmbeddings();
    try {
      await expect.poll(() => !!releaseImages).toBe(true);
      expect((await ml.status()).embeddingRunning).toBe(true);
      await ml.enqueueEmbeddings(); // already running: must not start a second worker
    } finally {
      holdImages = false;
      releaseImages?.();
      releaseImages = undefined;
      await run;
      fs.rmSync(thumb, { force: true });
    }
    const after = await ml.status();
    expect(after.embeddingRunning).toBe(false);
    expect(after.embedded).toBe(before.embedded + 1);
    expect(after.embedded).toBeLessThan(after.total);
    expect(await db.fileEmbedding.findUnique({ where: { fileId: ids[1]! } })).toBeNull();
  });

  it("combined tag vector: cold start = text embedding; cache invalidated by deletion", async () => {
    const tag = await db.tag.findUnique({ where: { name: "mltag" } });
    const v1 = await ml.tagVector(tag!.id);
    expect(v1).not.toBeNull();
    const norm = Math.sqrt(v1!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);

    // invalidate → row deleted → next call recomputes
    await ml.invalidateTagVectors(["mltag"]);
    const gone = await db.tagVector.findUnique({ where: { tagId: tag!.id } });
    expect(gone).toBeNull();
    await ml.tagVector(tag!.id);
    const cached = await db.tagVector.findUnique({ where: { tagId: tag!.id } });
    expect(cached).not.toBeNull();
  });

  it("suggestTagsForFile excludes tags already on the file", async () => {
    await setTags(["ml1"], ["other"], []);
    const out = await ml.suggestTagsForFile("ml1");
    expect(out.every((s) => s.tag !== "mltag" && s.tag !== "other")).toBe(true);
  });

  it("semantic search over-fetches knn pages and filters by tag set", async () => {
    const evens = Array.from({ length: 600 }, (_, i) => `mlf${i}`).filter(
      (id) => Number(id.slice(3)) % 2 === 0,
    );
    await db.file.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({
        id: `mlf${i}`,
        size: 1,
        mtime: new Date(i),
        mediaType: "image" as const,
      })),
    });
    await setTags(evens, ["evenonly"], []);

    const hits = Array.from({ length: 600 }, (_, i) => ({
      fileId: `mlf${i}`,
      score: 1 - i / 600,
    }));
    const stubKnn = async (_q: unknown, k: number, skip: number) => hits.slice(skip, skip + k);

    const res = await semanticSearch(
      makeToken({ kind: "text", tag: "hello" }),
      [makeToken({ tag: "evenonly" })],
      null,
      5,
      stubKnn,
    );
    expect(res.items).toHaveLength(5);
    expect(res.items.every((i) => Number(i.id.slice(3)) % 2 === 0)).toBe(true);
    expect(res.nextCursor).not.toBeNull();
    const second = await semanticSearch(makeToken({ kind: "text", tag: "hello" }), [makeToken({ tag: "evenonly" })], res.nextCursor, 5, stubKnn);
    expect(second.items.map((i) => i.id)).toEqual(["mlf10", "mlf12", "mlf14", "mlf16", "mlf18"]);
  });

  it("sidecar failure falls back to tag-only paging without reusing a vector cursor", async () => {
    const fail = async () => { throw new ml.SidecarError("unavailable"); };
    const text = makeToken({ kind: "text", tag: "hello" });
    const tags = [makeToken({ tag: "evenonly" })];
    const restart = await semanticSearch(text, tags, "4000", 5, fail);
    expect(restart.items).toEqual([]);
    expect("restart" in restart && restart.restart).toBe(true);
    const first = await semanticSearch(text, tags, null, 5, fail);
    expect(first.items.map((i) => i.id)).toEqual(["mlf598", "mlf596", "mlf594", "mlf592", "mlf590"]);
    expect(first.nextCursor).toMatch(/^tag:/);
    expect("notice" in first && first.notice).toContain("unavailable");
    const second = await semanticSearch(text, tags, first.nextCursor, 5, fail);
    expect(second.items.map((i) => i.id)).toEqual(["mlf588", "mlf586", "mlf584", "mlf582", "mlf580"]);
    await expect(semanticSearch(text, tags, null, 5, async () => { throw new Error("not a sidecar failure"); })).rejects.toThrow("not a sidecar failure");
  });

  it("suggestion rejection can be undone without confusing an existing denial", async () => {
    expect(await ml.excludeSuggestion("denial-test", "ml1")).toEqual({ alreadyExcluded: false });
    expect(await ml.excludeSuggestion("denial-test", "ml1")).toEqual({ alreadyExcluded: true });
    expect((await ml.getExclusions("denial-test")).has("ml1")).toBe(true);
    await ml.restoreSuggestion("denial-test", "ml1");
    expect((await ml.getExclusions("denial-test")).has("ml1")).toBe(false);
  });

  it("tag vector uses image centroid when images are embedded (§13.4)", async () => {
    // embed one file tagged with "weighted"
    await db.file.create({ data: { id: "img1", size: 1, mtime: new Date(), mediaType: "image" } });
    await setTags(["img1"], ["weighted"], []);
    await db.fileEmbedding.create({
      data: { fileId: "img1", vector: Buffer.from(new Float32Array(vec(42)).buffer), model: mlModel() },
    });
    const tag = await db.tag.findUnique({ where: { name: "weighted" } });
    const v = await ml.tagVector(tag!.id);
    expect(v).not.toBeNull();
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
    const row = await db.tagVector.findUnique({ where: { tagId: tag!.id } });
    expect(row!.fileCount).toBeGreaterThan(0);
  });

  it("vectorSearch excludes the similar seed id and paginates", async () => {
    for (let i = 0; i < 10; i++) {
      await db.file.create({ data: { id: `vs${i}`, size: 1, mtime: new Date(i), mediaType: "image" } });
    }
    const hits = Array.from({ length: 10 }, (_, i) => ({ fileId: `vs${i}`, score: 1 - i / 10 }));
    const stubKnn = async (_q: unknown, k: number, skip: number) => hits.slice(skip, skip + k);
    const res = await vectorSearch(new Float32Array(768), [], null, 5, "vs0", stubKnn);
    expect(res.items.map((i) => i.id)).toEqual(["vs1", "vs2", "vs3", "vs4", "vs5"]);
    expect(res.nextCursor).not.toBeNull();
    const second = await vectorSearch(new Float32Array(768), [], res.nextCursor, 5, "vs0", stubKnn);
    expect(second.items.map((i) => i.id)).toEqual(["vs6", "vs7", "vs8", "vs9"]);
    expect(second.nextCursor).toBeNull();
  });

  it("suggestTagsForFiles scores the selection centroid, excludes selection-wide tags", async () => {
    await db.file.create({ data: { id: "img2", size: 1, mtime: new Date(), mediaType: "image" } });
    await db.fileEmbedding.create({
      data: { fileId: "img2", vector: Buffer.from(new Float32Array(vec(7)).buffer), model: mlModel() },
    });
    // "commontag" sits on the whole selection → excluded; "weighted" only on img1
    await setTags(["img1", "img2"], ["commontag"], []);
    const out = await ml.suggestTagsForFiles(["img1", "img2"]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.tag !== "commontag")).toBe(true);
    // scores descend
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.score).toBeGreaterThanOrEqual(out[i]!.score);
    // no embeddings → no suggestions
    expect(await ml.suggestTagsForFiles(["vs0"])).toEqual([]);
  });
});

function mlModel(): string {
  return `${config.get().ml.model}__${config.get().ml.pretrained}`;
}
