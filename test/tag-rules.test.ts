import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { db } from "refr/server/db";
import { paths } from "refr/server/services/dataDir";
import { getRules, saveRules, TagRulesInvalid } from "refr/server/services/tagRules";
import { applyRulesToExisting, merge, rename, searchTags, setTags } from "refr/server/services/tags";
import { makeToken, resolveTagAliases } from "refr/server/services/search";
import { searchRouter } from "refr/server/api/routers/search";
import { mainTimelineWhere } from "refr/server/services/fileQuery";
import * as config from "refr/server/services/config";
import { expandImplications, resolveAlias, sanitizeRules, validateRules, type TagRules } from "refr/lib/tag-rules";

// tag-rules.json is global to the shared test data dir: every test here leaves
// it removed so other suites' setTags calls see no rules.
const clearRules = () => fs.rmSync(paths.tagRules, { force: true });

const IDS = ["tr1", "tr2", "tr3", "tr4"];
async function tagsOf(fileId: string): Promise<string[]> {
  const rows = await db.fileTag.findMany({ where: { fileId }, include: { tag: true } });
  return rows.map((r) => r.tag.name).sort();
}

const rules = (r: Partial<TagRules>): TagRules => sanitizeRules({ aliases: {}, implications: {}, timelineHidden: [], ...r });

describe("tag rules (pure)", () => {
  it("resolves aliases by longest prefix, one hop", () => {
    const r = rules({ aliases: { fig: "reference/figure", "fig/h": "reference/hands" } });
    expect(resolveAlias(r, "Fig")).toBe("reference/figure");
    expect(resolveAlias(r, "fig/arms")).toBe("reference/figure/arms");
    expect(resolveAlias(r, "fig/h/left")).toBe("reference/hands/left");
    expect(resolveAlias(r, "figure")).toBe("figure");
  });

  it("expands implications transitively and through ancestors", () => {
    const r = rules({ implications: { "artist/x": ["medium/digital"], "medium/digital": ["style/painterly"] } });
    expect(expandImplications(r, ["artist/x/sketch"]).sort()).toEqual(["medium/digital", "style/painterly"]);
    expect(expandImplications(r, ["artist/y"])).toEqual([]);
  });

  it("rejects loops, chains and hierarchy-redundant rules", () => {
    expect(validateRules(rules({ implications: { a: ["b"], b: ["a/x"] } }))).not.toEqual([]);
    expect(validateRules(rules({ aliases: { x: "y", y: "z" } }))).not.toEqual([]);
    expect(validateRules(rules({ aliases: { x: "x/y" } }))).not.toEqual([]);
    expect(validateRules(rules({ implications: { "a/b": ["a"] } }))).not.toEqual([]);
    expect(validateRules(rules({ aliases: { fig: "reference/figure" }, implications: { a: ["b"] } }))).toEqual([]);
  });

  it("normalizes timeline-hidden tags and rejects aliases", () => {
    expect(rules({ timelineHidden: ["NSFW", "nsfw/gore", "wip", "wip"] }).timelineHidden).toEqual(["nsfw", "wip"]);
    expect(validateRules(rules({ aliases: { x: "y" }, timelineHidden: ["x"] }))).not.toEqual([]);
    expect(validateRules(rules({ aliases: { x: "y" }, timelineHidden: ["y"] }))).toEqual([]);
  });

  it("rewrites alias chips in search tokens, leaving keywords and wildcards", () => {
    const r = rules({ aliases: { fig: "reference/figure" } });
    const out = resolveTagAliases(
      [makeToken({ tag: "fig/arms", negate: true }), makeToken({ tag: "fig*" }), makeToken({ tag: "untagged" }), makeToken({ tag: "suggest:fig" })],
      r,
    );
    expect(out.map((t) => t.tag)).toEqual(["reference/figure/arms", "fig*", "untagged", "suggest:reference/figure"]);
    expect(out[0]!.negate).toBe(true);
  });
});

describe("tag rules (applied)", () => {
  beforeAll(async () => {
    clearRules();
    for (const id of IDS) await db.file.create({ data: { id, size: 1, mtime: new Date(), mediaType: "image" } });
  });
  afterAll(clearRules);

  it("saveRules validates", () => {
    expect(() => saveRules(rules({ implications: { a: ["b"], b: ["a"] } }))).toThrow(TagRulesInvalid);
    expect(fs.existsSync(paths.tagRules)).toBe(false);
  });

  it("setTags resolves aliases and adds implied tags", async () => {
    saveRules(rules({
      aliases: { trfig: "trref/figure" },
      implications: { "trartist/x": ["trmedium/digital"], "trmedium/digital": ["trstyle/paint"] },
    }));
    await setTags(["tr1"], ["trfig/arms", "trartist/x/sketch"], []);
    expect(await tagsOf("tr1")).toEqual(["trartist/x/sketch", "trmedium/digital", "trref/figure/arms", "trstyle/paint"]);
  });

  it("implied tags skip files already carrying a descendant", async () => {
    await setTags(["tr2"], ["trmedium/digital/krita"], []);
    await setTags(["tr2"], ["trartist/x"], []);
    expect(await tagsOf("tr2")).toEqual(["trartist/x", "trmedium/digital/krita", "trstyle/paint"]);
  });

  it("search and autocomplete resolve aliases", async () => {
    const search = searchRouter.createCaller({ db, authed: true, headers: new Headers() });
    const res = await search.query({ tokens: [makeToken({ tag: "trfig" })], sort: "date" });
    expect(res.items.map((i) => i.id)).toEqual(["tr1"]);
    const rows = await searchTags("trfig");
    expect(rows[0]).toMatchObject({ name: "trref/figure", alias: "trfig" });
  });

  it("rename and merge rewrite rule references", async () => {
    await rename("trmedium", "trmed");
    expect(getRules().implications["trartist/x"]).toEqual(["trmed/digital"]);
    expect(getRules().implications["trmed/digital"]).toEqual(["trstyle/paint"]);
    await merge(["trstyle/paint"], "trstyle/painterly");
    expect(getRules().implications["trmed/digital"]).toEqual(["trstyle/painterly"]);
  });

  it("applyToExisting renames alias-named tags and backfills implications", async () => {
    clearRules();
    await setTags(["tr3"], ["trshort/a"], []);
    await setTags(["tr4"], ["trsrc/child"], []);
    saveRules(rules({ aliases: { trshort: "trlong" }, implications: { trsrc: ["trimplied"] } }));
    const result = await applyRulesToExisting();
    expect(result.renamedTags).toBe(1);
    expect(result.changedFiles).toBeGreaterThanOrEqual(1);
    expect(await tagsOf("tr3")).toEqual(["trlong/a"]);
    expect(await tagsOf("tr4")).toEqual(["trimplied", "trsrc/child"]);
    // idempotent
    expect(await applyRulesToExisting()).toEqual({ renamedTags: 0, changedFiles: 0 });
  });

  it("timeline-hidden tags leave the main timeline but stay searchable", async () => {
    clearRules();
    // fixtures have no library paths: test only the tag half of the timeline filter
    const previous = config.get().libraries;
    config.patch({ libraries: [] });
    onTestFinished(() => { config.patch({ libraries: previous }); });
    await setTags(["tr1"], ["trhide/sub"], []);
    const onTimeline = async () => {
      const where = mainTimelineWhere();
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT f.id FROM File f WHERE (${where?.text ?? "1=1"}) AND f.id IN (${IDS.map(() => "?").join(",")}) ORDER BY f.id`,
        ...(where?.params ?? []), ...IDS,
      );
      return rows.map((r) => r.id);
    };
    expect(await onTimeline()).toContain("tr1");
    saveRules(rules({ timelineHidden: ["trhide"] }));
    expect(await onTimeline()).toEqual(IDS.filter((id) => id !== "tr1"));
    const search = searchRouter.createCaller({ db, authed: true, headers: new Headers() });
    expect((await search.query({ tokens: [makeToken({ tag: "trhide" })] })).items.map((i) => i.id)).toEqual(["tr1"]);
    await rename("trhide", "trhidden");
    expect(getRules().timelineHidden).toEqual(["trhidden"]);
    expect(await onTimeline()).not.toContain("tr1");
  });
});
