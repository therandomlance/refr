import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { deleteTemplate, finish, generate, getHistory, getTemplate, saveTemplate, replay, renameTemplate, stats } from "refr/server/services/sessions";
import { makeToken } from "refr/server/services/search";
import { setTags } from "refr/server/services/tags";
import * as config from "refr/server/services/config";

const TPL = "test-session";

async function seedFiles() {
  for (let i = 0; i < 30; i++) {
    const id = `s${i}`;
    await db.file.create({ data: { id, size: 1, mtime: new Date(), mediaType: "image" } });
    await setTags([id], [i < 20 ? "figures" : "hands"], []);
  }
}

describe("sessions", () => {
  it("setup + template", async () => {
    await seedFiles();
    saveTemplate({
      name: TPL,
      blocks: [
        { tag: "figures", count: 10, seconds: 60, autoScroll: true },
        { tag: "hands", count: 3, seconds: null, autoScroll: false },
      ],
    });
  });

  it("generates correct counts with no cross-block repeats", async () => {
    const entry = await generate(TPL);
    expect(entry.blocks[0]!.fileIds).toHaveLength(10);
    expect(entry.blocks[1]!.fileIds).toHaveLength(3);
    const all = entry.blocks.flatMap((b) => b.fileIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it("history truncates at cap", async () => {
    config.patch({ sessionHistoryCap: 5 });
    for (let i = 0; i < 8; i++) await generate(TPL);
    expect(getHistory(TPL).length).toBeLessThanOrEqual(5);
    config.patch({ sessionHistoryCap: 1000 });
  });

  it("replay returns a fixed entry", async () => {
    const entry = replay(TPL, 0);
    expect(entry.blocks.length).toBeGreaterThan(0);
  });

  it("renaming to the same name keeps the template (no self-delete)", () => {
    renameTemplate(TPL, TPL);
    expect(getTemplate(TPL)).not.toBeNull();
  });
});

describe("session upgrades", () => {
  const NAME = "test-session-v2";
  const tok = (tag: string, negate = false) => makeToken({ tag, negate });

  it("draws token blocks, records breaks with timing", async () => {
    await setTags(["s0", "s1"], ["figures/back"], []);
    saveTemplate({
      name: NAME,
      blocks: [
        { tag: "figures -figures/back", tokens: [tok("figures"), tok("figures/back", true)], count: 50, seconds: 30, autoScroll: true },
        { kind: "break", seconds: 60 },
        { tag: "hands", count: 2 },
      ],
    });
    const entry = await generate(NAME);
    const [figs, rest, hands] = entry.blocks;
    expect(figs!.fileIds).toHaveLength(18); // 20 figures minus the 2 tagged back
    expect(figs!.fileIds).not.toContain("s0");
    expect(figs).toMatchObject({ seconds: 30, autoScroll: true, kind: "images" });
    expect(rest).toMatchObject({ kind: "break", fileIds: [], seconds: 60, tag: "Break" });
    expect(hands!.fileIds).toHaveLength(2);
  });

  it("legacy templates (tag only, no kind) still load and draw", async () => {
    const tpl = getTemplate(TPL)!;
    expect(tpl.blocks[0]).toMatchObject({ kind: "images", tag: "figures" });
    expect(tpl.avoidRecent).toBe(0);
  });

  it("avoidRecent prefers unseen images, then falls back", async () => {
    saveTemplate({ name: NAME, avoidRecent: 1, blocks: [{ tag: "hands", count: 6 }] });
    const first = (await generate(NAME)).blocks[0]!.fileIds;
    const second = (await generate(NAME)).blocks[0]!.fileIds;
    expect(first).toHaveLength(6);
    expect(second).toHaveLength(6);
    // 10 hands images: the second run takes the 4 unseen ones before reusing any
    const reused = second.filter((id) => first.includes(id));
    expect(reused).toHaveLength(2);
  });

  it("finish records time and progress; stats aggregate finished runs", async () => {
    const entry = getHistory(NAME)[0]!;
    finish(NAME, entry.date, { elapsedSeconds: 300, viewed: 4 });
    const after = getHistory(NAME)[0]!;
    expect(after).toMatchObject({ elapsedSeconds: 300, viewed: 4 });
    expect(after.finishedAt).toBeTruthy();
    const s = stats();
    expect(s.totals.seconds).toBeGreaterThanOrEqual(300);
    expect(s.tags.find((t) => t.tag === "hands")?.images).toBeGreaterThanOrEqual(4);
    expect(s.days.at(-1)!.seconds).toBeGreaterThanOrEqual(300);
    deleteTemplate(NAME);
  });

  it("rejects image blocks without a search and breaks without a time", () => {
    expect(() => saveTemplate({ name: NAME, blocks: [{ tag: "", count: 1 }] })).toThrow();
    expect(() => saveTemplate({ name: NAME, blocks: [{ kind: "break" }] })).toThrow();
  });
});
