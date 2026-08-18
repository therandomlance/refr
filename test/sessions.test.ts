import { describe, expect, it } from "vitest";
import { db } from "refr/server/db";
import { generate, getHistory, saveTemplate, replay } from "refr/server/services/sessions";
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
});
