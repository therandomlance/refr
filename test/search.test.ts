import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import {
  commitToken,
  parseQuery,
  serializeQuery,
  tokensToWhere,
  resolvePathAliases,
  makeToken,
  type Token,
} from "refr/server/services/search";
import { executeList } from "refr/server/services/fileQuery";

describe("query grammar", () => {
  it("parse/serialize round-trips", () => {
    const cases = [
      "reference/figure arms",
      "figure -arms",
      "~reference/figure ~artwork/fanart",
      "=reference/figure",
      "artwork/fanart/* */liara mass*",
      "-=reference/figure",
      "~=x",
      "-*nsfw*",
      "suggest:artwork/fanart",
    ];
    for (const c of cases) {
      expect(serializeQuery(parseQuery(c))).toBe(c);
    }
  });

  it("autocomplete suggestions keep spaces in multi-word tags", () => {
    const tag = "artwork/fanart/fortnite/meow skulls";
    expect(commitToken(tag, tag)).toMatchObject({ tag, negate: false, exact: false, or: false });
    expect(commitToken("-" + tag, tag)).toMatchObject({ tag, negate: true });
    expect(commitToken("=suggest:" + tag, "suggest:" + tag)).toMatchObject({ tag: "suggest:" + tag, exact: true });
    // typed text (no row picked) is one chip too — not split on spaces
    expect(commitToken("-" + tag)).toMatchObject({ tag, negate: true });
    expect(commitToken(" =path:refs/My Folder ")).toMatchObject({ tag: "path:refs/My Folder", exact: true });
    expect(commitToken('"red car"')).toMatchObject({ kind: "text", tag: "red car" });
    expect(commitToken("-")).toBeNull();
  });

  it("quoted text chips survive parse/serialize", () => {
    const tokens = parseQuery('figure "a happy cat" -arms');
    expect(tokens.find((t) => t.kind === "text")?.tag).toBe("a happy cat");
    expect(serializeQuery(tokens)).toContain('"a happy cat"');
  });
});

describe("SQL translation (seeded sqlite)", () => {
  const files = ["f1", "f2", "f3", "f4"];
  const tagmap: Record<string, string[]> = {
    f1: ["reference/figure", "reference/figure/arms"],
    f2: ["artwork/fanart/mass effect/liara"],
    f3: ["reference"],
    // f4 untagged
  };

  it("setup", async () => {
    for (const id of files) {
      await db.file.create({
        data: { id, size: 100, mtime: new Date(), mediaType: "image" },
      });
      for (const tag of tagmap[id] ?? []) {
        const t = await db.tag.upsert({ where: { name: tag }, create: { name: tag }, update: {} });
        await db.fileTag.create({ data: { fileId: id, tagId: t.id } });
      }
    }
  });

  async function idsOf(tokens: Token[]): Promise<string[]> {
    const where = tokensToWhere(tokens);
    const res = await executeList({ where, sort: "date" });
    // scope to this file's fixtures — the shared test DB holds other suites' rows
    return res.items.map((i) => i.id).filter((id) => /^f\d$/.test(id)).sort();
  }

  it("descendant match by default", async () => {
    expect(await idsOf(parseQuery("reference/figure"))).toEqual(["f1"]);
    expect(await idsOf(parseQuery("reference"))).toEqual(["f1", "f3"]);
  });

  it("AND over multiple terms", async () => {
    expect(await idsOf(parseQuery("reference/figure reference/figure/arms"))).toEqual(["f1"]);
  });

  it("NOT", async () => {
    expect(await idsOf(parseQuery("reference -reference/figure/arms"))).toEqual(["f3"]);
  });

  it("OR group", async () => {
    expect(await idsOf(parseQuery("~reference ~artwork"))).toEqual(["f1", "f2", "f3"]);
  });


  it("exact match excludes descendants", async () => {
    expect(await idsOf(parseQuery("=reference"))).toEqual(["f3"]);
    expect(await idsOf(parseQuery("-=reference"))).toEqual(["f1", "f2", "f4"]);
  });

  it("wildcards", async () => {
    expect(await idsOf(parseQuery("*/liara"))).toEqual(["f2"]);
    expect(await idsOf(parseQuery("artwork*"))).toEqual(["f2"]);
    expect(await idsOf(parseQuery("artwork/fanart/*"))).toEqual(["f2"]);
    expect(await idsOf(parseQuery("-*nsfw*"))).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("untagged keyword", async () => {
    expect(await idsOf(parseQuery("untagged"))).toEqual(["f4"]);
  });

  it("tagged keyword", async () => {
    expect(await idsOf(parseQuery("tagged"))).toEqual(["f1", "f2", "f3"]);
    expect(await idsOf(parseQuery("-tagged"))).toEqual(["f4"]);
  });

  it("setup paths", async () => {
    await db.filePath.create({ data: { path: "/refrtest/lib/sub/a.png", fileId: "f1", size: 1, mtime: new Date() } });
    await db.filePath.create({ data: { path: "/refrtest/lib/b.png", fileId: "f2", size: 1, mtime: new Date() } });
    await db.filePath.create({ data: { path: "/refrtest/other/c.png", fileId: "f3", size: 1, mtime: new Date() } });
    await db.filePath.create({ data: { path: "/refrtest/other/d.png", fileId: "f4", size: 1, mtime: new Date() } });
  });

  it("path: keyword filters by library path", async () => {
    expect(await idsOf(parseQuery("path:/refrtest/lib"))).toEqual(["f1", "f2"]);
    expect(await idsOf(parseQuery("path:/refrtest/lib/sub"))).toEqual(["f1"]);
    expect(await idsOf(parseQuery("path:/refrtest/lib/b.png"))).toEqual(["f2"]);
    expect(await idsOf(parseQuery("-path:/refrtest/other"))).toEqual(["f1", "f2"]);
  });

  it("OR group accepts path and metadata clauses", async () => {
    expect(await idsOf(parseQuery("~path:/refrtest/lib ~untagged"))).toEqual(["f1", "f2", "f4"]);
  });

  it("=path: matches direct children only", async () => {
    expect(await idsOf(parseQuery("=path:/refrtest/lib"))).toEqual(["f2"]);
  });

  it("path:<alias> resolves to the library root", async () => {
    const aliases = { lib: "/refrtest/lib" };
    const run = async (q: string) => {
      const where = tokensToWhere(resolvePathAliases(parseQuery(q), aliases));
      const res = await executeList({ where, sort: "date" });
      return res.items.map((i) => i.id).filter((id) => /^f\d$/.test(id)).sort();
    };
    expect(await run("path:lib")).toEqual(["f1", "f2"]);
    expect(await run("=path:lib")).toEqual(["f2"]);
    expect(await run("-path:lib")).toEqual(["f3", "f4"]);
    // subfolders under an alias, case-insensitive alias, trailing slash
    expect(await run("path:lib/sub")).toEqual(["f1"]);
    expect(await run("path:LIB/sub/")).toEqual(["f1"]);
    expect(await run("=path:lib/sub")).toEqual(["f1"]);
    expect(await run("-path:lib/sub")).toEqual(["f2", "f3", "f4"]);
    expect(await idsOf(parseQuery("path:/refrtest/lib/sub/"))).toEqual(["f1"]);
    // case-sensitive like the filesystem (SQLite LIKE would fold ASCII case)
    expect(await idsOf(parseQuery("path:/refrtest/LIB"))).toEqual([]);
    expect(await idsOf(parseQuery("path:/refrtest/lib/SUB"))).toEqual([]);
  });

  it("multi-word tag with spaces", async () => {
    // multi-word tags are expressed as chips (canonical), not the string grammar
    expect(await idsOf([makeToken({ tag: "artwork/fanart/mass effect/liara" })])).toEqual(["f2"]);
  });
});

describe("metadata + value keywords", () => {
  const day = 86_400_000;
  // kw1 landscape image, 3 tags, dated 2024-03-15, added today, has a path
  // kw2 portrait video, untagged, dated 2023, added 40 days ago, no paths (missing)
  // kw3 square image (1000×1010, within 2%), 1 tag, dated 2024-12-31
  // kw4 image with unknown dimensions
  const fixtures = [
    { id: "kw1", w: 3000, h: 2000, type: "image", mtime: new Date(2024, 2, 15, 12), added: Date.now(), tags: ["kwt/a", "kwt/b", "kwt/c"], path: true },
    { id: "kw2", w: 1080, h: 1920, type: "video", mtime: new Date(2023, 6, 1), added: Date.now() - 40 * day, tags: [], path: false },
    { id: "kw3", w: 1000, h: 1010, type: "image", mtime: new Date(2024, 11, 31, 23), added: Date.now() - 3 * day, tags: ["kwt/a"], path: true },
    { id: "kw4", w: null, h: null, type: "image", mtime: new Date(2025, 0, 1), added: Date.now() - 400 * day, tags: [], path: true },
  ] as const;

  it("setup", async () => {
    for (const f of fixtures) {
      await db.file.create({
        data: { id: f.id, size: 1, mtime: f.mtime, addedAt: new Date(f.added), mediaType: f.type, width: f.w, height: f.h },
      });
      if (f.path) await db.filePath.create({ data: { path: `/refrtest/kw/${f.id}.png`, fileId: f.id, size: 1, mtime: f.mtime } });
      for (const tag of f.tags) {
        const t = await db.tag.upsert({ where: { name: tag }, create: { name: tag }, update: {} });
        await db.fileTag.create({ data: { fileId: f.id, tagId: t.id } });
      }
    }
  });

  async function ids(q: string): Promise<string[]> {
    // scope in SQL, not after paging: broad keywords (`missing`, `tags=0`) match other
    // suites' rows too, which can push these older-dated fixtures off the first page
    const w = tokensToWhere(parseQuery(q));
    const res = await executeList({ where: { text: `(${w.text}) AND f.id LIKE 'kw%'`, params: w.params }, sort: "date" });
    return res.items.map((i) => i.id).sort();
  }

  it("type and orientation", async () => {
    expect(await ids("type:video")).toEqual(["kw2"]);
    expect(await ids("type:image")).toEqual(["kw1", "kw3", "kw4"]);
    expect(await ids("orient:landscape")).toEqual(["kw1"]);
    expect(await ids("orient:portrait")).toEqual(["kw2"]);
    expect(await ids("orient:square")).toEqual(["kw3"]);
  });

  it("wallpaper", async () => {
    const wp = [
      { id: "wp1", w: 1280, h: 720, type: "image" }, // 16:9, at the 720 minimum
      { id: "wp2", w: 3440, h: 1440, type: "image" }, // ultrawide
      { id: "wp3", w: 1024, h: 576, type: "image" }, // 16:9 but too small
      { id: "wp4", w: 1920, h: 1200, type: "image" }, // 16:10
      { id: "wp5", w: 3840, h: 2160, type: "video" }, // not an image
      { id: "wp6", w: 1600, h: 1200, type: "image" }, // 4:3
    ];
    for (const f of wp) {
      await db.file.create({
        data: { id: f.id, size: 1, mtime: new Date(2024, 0, 1), mediaType: f.type, width: f.w, height: f.h },
      });
    }
    const wpIds = async (q: string) => {
      const w = tokensToWhere(parseQuery(q));
      const res = await executeList({ where: { text: `(${w.text}) AND f.id LIKE 'wp%'`, params: w.params }, sort: "date" });
      return res.items.map((i) => i.id).sort();
    };
    expect(await wpIds("wallpaper:any")).toEqual(["wp1", "wp2", "wp4"]);
    expect(await wpIds("wallpaper:16:9")).toEqual(["wp1"]);
    expect(await wpIds("wallpaper:16:10")).toEqual(["wp4"]);
    expect(await wpIds("wallpaper:21:9")).toEqual(["wp2"]);
    expect(await wpIds("-wallpaper:any")).toEqual(["wp3", "wp5", "wp6"]);
    expect(await ids("wallpaper:any")).toEqual([]);
    // bare `wallpaper` is an ordinary tag, not a keyword
    expect(await wpIds("wallpaper")).toEqual([]);
  });

  it("missing", async () => {
    expect(await ids("missing")).toEqual(["kw2"]);
    expect(await ids("-missing")).toEqual(["kw1", "kw3", "kw4"]);
  });

  it("dimension comparisons skip unknown sizes", async () => {
    expect(await ids("w>2000")).toEqual(["kw1"]);
    expect(await ids("w>=1080")).toEqual(["kw1", "kw2"]);
    expect(await ids("h<1500")).toEqual(["kw3"]);
    expect(await ids("w=1000")).toEqual(["kw3"]);
    expect(await ids("-w>2000")).toEqual(["kw2", "kw3", "kw4"]);
  });

  it("tag count", async () => {
    expect(await ids("tags=0")).toEqual(["kw2", "kw4"]);
    expect(await ids("tags>=1")).toEqual(["kw1", "kw3"]);
    expect(await ids("tags>2")).toEqual(["kw1"]);
  });

  it("added:", async () => {
    expect(await ids("added:7d")).toEqual(["kw1", "kw3"]);
    expect(await ids("added:2m")).toEqual(["kw1", "kw2", "kw3"]);
    expect(await ids("-added:1y")).toEqual(["kw4"]);
  });

  it("date:", async () => {
    expect(await ids("date:2024")).toEqual(["kw1", "kw3"]);
    expect(await ids("date:2024-03")).toEqual(["kw1"]);
    expect(await ids("date:2024-03-15")).toEqual(["kw1"]);
    expect(await ids("date:2024-12")).toEqual(["kw3"]);
    expect(await ids("date:2023-07-01")).toEqual(["kw2"]);
  });

  it("combines with tags and each other", async () => {
    expect(await ids("kwt type:image orient:square")).toEqual(["kw3"]);
    expect(await ids("~type:video ~w>2000")).toEqual(["kw1", "kw2"]);
  });

  it("malformed values stay ordinary tags", async () => {
    expect(await ids("w>abc")).toEqual([]);
    expect(await ids("date:2024-13")).toEqual([]);
    expect(await ids("added:7x")).toEqual([]);
  });
});
