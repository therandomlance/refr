import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import {
  parseQuery,
  serializeQuery,
  tokensToWhere,
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
    ];
    for (const c of cases) {
      expect(serializeQuery(parseQuery(c))).toBe(c);
    }
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

  it("multi-word tag with spaces", async () => {
    // multi-word tags are expressed as chips (canonical), not the string grammar
    expect(await idsOf([makeToken({ tag: "artwork/fanart/mass effect/liara" })])).toEqual(["f2"]);
  });
});
