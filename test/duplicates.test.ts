import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { dismissPair, dhashOf, findPairs, listPairs, resolvePair, storeHash, unhide } from "refr/server/services/duplicates";
import { setFavorite } from "refr/server/services/fileMeta";
import { setTags } from "refr/server/services/tags";
import { generate, saveTemplate, deleteTemplate } from "refr/server/services/sessions";
import { searchRouter } from "refr/server/api/routers/search";
import { makeToken } from "refr/server/services/search";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refr-dup-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A deterministic non-flat test image (diagonal bands + a block). */
async function pattern(file: string, w: number, h: number) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = (Math.floor((x * 7 + y * 3) / Math.max(1, w / 16)) * 37) % 256;
      const block = x > w / 2 && y < h / 3 ? 200 : 0;
      px[i] = v; px[i + 1] = (v + block) % 256; px[i + 2] = 255 - v;
    }
  }
  await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
}

const bitsBetween = (a: bigint, b: bigint) => BigInt.asUintN(64, a ^ b).toString(2).replace(/0/g, "").length;

describe("dhash", () => {
  it("is stable under resize and re-encode", async () => {
    const big = path.join(tmp, "big.png");
    const small = path.join(tmp, "small.jpg");
    await pattern(big, 640, 480);
    await sharp(big).resize(200).jpeg({ quality: 70 }).toFile(small);
    const other = path.join(tmp, "other.png");
    await sharp(big).flop().toFile(other);
    const [a, b, c] = await Promise.all([dhashOf(big), dhashOf(small), dhashOf(other)]);
    expect(bitsBetween(a, b)).toBeLessThanOrEqual(3);
    expect(bitsBetween(a, c)).toBeGreaterThan(10);
  });
});

describe("findPairs", () => {
  const base = 0x0123_4567_89ab_cdefn;
  it("finds every pair within 3 bits, skips flat hashes and dismissals", () => {
    const entries = [
      { id: "a", hash: base },
      { id: "b", hash: base ^ 0b1n }, // 1 bit
      { id: "c", hash: base ^ ((1n << 3n) | (1n << 20n) | (1n << 40n)) }, // 3 bits, 3 bands
      { id: "d", hash: base ^ ((1n << 1n) | (1n << 17n) | (1n << 33n) | (1n << 49n)) }, // 4 bits, all bands
      { id: "z1", hash: 0n }, // flat
      { id: "z2", hash: 1n },
    ];
    const pairs = findPairs(entries);
    const keys = pairs.map((p) => `${p.a}|${p.b}`);
    expect(keys).toContain("a|b");
    expect(keys).toContain("a|c");
    expect(keys).not.toContain("a|d");
    expect(keys.some((k) => k.includes("z"))).toBe(false);
    expect(pairs[0]).toEqual({ a: "a", b: "b", distance: 1 });
    expect(findPairs(entries, new Set(["a|b"])).map((p) => `${p.a}|${p.b}`)).not.toContain("a|b");
  });
});

describe("resolve, hide, favorites", () => {
  const keeper = "dupkeep";
  const copy = "dupcopy";
  const other = "dupother";
  beforeAll(async () => {
    for (const id of [keeper, copy, other]) {
      await db.file.create({ data: { id, size: 1, mtime: new Date(), mediaType: "image", width: 10, height: 10 } });
    }
    await setTags([keeper, copy, other], ["dupset"], []);
    await setTags([copy], ["dupset/extra"], []);
    const h = 0x7777_0000_ffff_1234n;
    await storeHash(keeper, h);
    await storeHash(copy, h ^ 0b10n);
    await storeHash(other, ~h);
    await db.fileMeta.update({ where: { fileId: copy }, data: { source: "https://example.test/a", favorite: true } });
  });

  it("lists the pair for a file", async () => {
    const res = await listPairs({ fileId: keeper, offset: 0, limit: 10 });
    expect(res.pairs.map((p) => [p.a.id, p.b.id].sort())).toEqual([[copy, keeper].sort()]);
  });

  it("dismissal removes the pair", async () => {
    await dismissPair(keeper, copy);
    expect((await listPairs({ fileId: keeper, offset: 0, limit: 10 })).pairs).toEqual([]);
    await db.duplicateDismissal.deleteMany({ where: { a: { in: [keeper, copy] } } });
  });

  it("resolve merges tags/favorite/source onto the keeper and hides the copy", async () => {
    await resolvePair(keeper, copy);
    const tags = (await db.fileTag.findMany({ where: { fileId: keeper }, include: { tag: true } })).map((t) => t.tag.name);
    expect(tags).toContain("dupset/extra");
    const meta = await db.fileMeta.findUnique({ where: { fileId: keeper } });
    expect(meta).toMatchObject({ favorite: true, source: "https://example.test/a", duplicateOf: null });
    expect((await db.fileMeta.findUnique({ where: { fileId: copy } }))?.duplicateOf).toBe(keeper);
  });

  it("hidden copies are left out of search and sessions unless asked for", async () => {
    const search = searchRouter.createCaller({ db, authed: true, headers: new Headers() });
    const ids = async (tags: string[]) =>
      (await search.query({ tokens: tags.map((tag) => makeToken({ tag })), sort: "date" })).items.map((i) => i.id).sort();
    expect(await ids(["dupset"])).toEqual([keeper, other].sort());
    expect(await ids(["dupset", "is:duplicate"])).toEqual([copy]);

    saveTemplate({ name: "dup-test", blocks: [{ tag: "dupset", count: 10, seconds: null, autoScroll: false }] });
    try {
      const run = await generate("dup-test");
      expect(run.blocks[0]!.fileIds.sort()).toEqual([keeper, other].sort());
    } finally {
      deleteTemplate("dup-test");
    }

    await unhide(copy);
    expect(await ids(["dupset"])).toEqual([copy, keeper, other].sort());
  });

  it("favorite toggles and filters", async () => {
    const search = searchRouter.createCaller({ db, authed: true, headers: new Headers() });
    const favs = async () =>
      (await search.query({ tokens: [makeToken({ tag: "dupset" }), makeToken({ tag: "fav" })], sort: "date" })).items;
    // keeper is already a favorite (merged from the copy); toggling a mixed set favorites all
    expect(await setFavorite([keeper, other])).toMatchObject({ favorite: true });
    expect((await favs()).map((f) => f.id).sort()).toEqual([copy, keeper, other].sort());
    expect((await favs()).every((f) => f.favorite)).toBe(true);
    expect(await setFavorite([keeper, other])).toMatchObject({ favorite: false });
    expect((await favs()).map((f) => f.id)).toEqual([copy]);
  });
});
