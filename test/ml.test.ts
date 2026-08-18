import { describe, expect, it, afterAll } from "vitest";
import http from "node:http";
import { db } from "refr/server/db";
import * as config from "refr/server/services/config";
import * as ml from "refr/server/services/ml";
import { semanticSearch, vectorSearch } from "refr/server/services/semantic";
import { setTags } from "refr/server/services/tags";
import { makeToken } from "refr/server/services/search";

// deterministic test vectors
function vec(seed: number): number[] {
  const v = Array.from({ length: 768 }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

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
      res.end(JSON.stringify({ vectors: (parsed.paths ?? []).map((p) => vec(p.length % 97)) }));
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

  it("combined tag vector: cold start = text embedding; cache invalidated by linksVersion", async () => {
    const tag = await db.tag.findUnique({ where: { name: "mltag" } });
    const v1 = await ml.tagVector(tag!.id);
    expect(v1).not.toBeNull();
    const norm = Math.sqrt(v1!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);

    // bump linksVersion → recompute path taken again (same result, but cache rewrote linksVersion)
    await ml.bumpLinksVersion();
    const cached1 = await db.tagVector.findUnique({ where: { tagId: tag!.id } });
    await ml.tagVector(tag!.id);
    const cached2 = await db.tagVector.findUnique({ where: { tagId: tag!.id } });
    expect(cached2!.linksVersion).toBeGreaterThan(cached1!.linksVersion);
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
  });
});

function mlModel(): string {
  return `${config.get().ml.model}__${config.get().ml.pretrained}`;
}
