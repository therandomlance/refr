import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { expect, it } from "vitest";
import { db } from "refr/server/db";
import * as config from "refr/server/services/config";
import { scanNow } from "refr/server/services/scanner";
import { parseQuery } from "refr/server/services/search";
import { searchRouter } from "refr/server/api/routers/search";
import { filesRouter } from "refr/server/api/routers/files";

it("indexes excluded libraries without showing them in the main timeline", async () => {
  const root = fs.mkdtempSync("/tmp/opencode/refr-timeline-");
  const visible = path.join(root, "visible_%");
  const hidden = path.join(root, "hidden");
  const previous = config.get().libraries;
  const search = searchRouter.createCaller({ db, authed: true, headers: new Headers() });
  const files = filesRouter.createCaller({ db, authed: true, headers: new Headers() });
  const ids: string[] = [];
  try {
    fs.mkdirSync(visible);
    fs.mkdirSync(hidden);
    config.patch({ libraries: [
      { path: visible, timeline: true },
      { path: hidden, alias: "hidden", timeline: false },
    ] });
    for (const [index, library] of [visible, visible, hidden].entries()) {
      const content = `${root}-${index}`;
      const file = path.join(library, `${index}.jpg`);
      fs.writeFileSync(file, content);
      const date = new Date(2020 + index, 0, 15, 12);
      fs.utimesSync(file, date, date);
      ids.push(crypto.createHash("sha256").update(content).digest("hex"));
    }
    await scanNow();
    expect(await db.file.count({ where: { id: { in: ids } } })).toBe(3);

    const first = await search.query({ tokens: [], limit: 1 });
    expect(first.items.map((f) => f.id)).toEqual([ids[1]]);
    const next = await search.query({ tokens: [], limit: 1, cursor: first.nextCursor });
    expect(next.items.map((f) => f.id)).toEqual([ids[0]]);
    expect(next.nextCursor).toBeNull();
    const seek = await search.query({ tokens: [], limit: 1, seek: `!${new Date(2020, 0, 16).getTime()}|` });
    expect(seek.items.map((f) => f.id)).toEqual([ids[0]]);
    const back = await search.query({ tokens: [], cursor: seek.prevCursor });
    expect(back.items.map((f) => f.id)).toEqual([ids[1]]);
    expect((await files.list({})).items.map((f) => f.id)).toEqual([ids[1], ids[0]]);
    expect((await search.timeline({ tokens: [] })).map((b) => b.year)).toEqual([2021, 2020]);
    expect((await files.timeline({})).map((b) => b.year)).toEqual([2021, 2020]);

    const tokens = parseQuery("path:hidden");
    expect((await search.query({ tokens })).items.map((f) => f.id)).toEqual([ids[2]]);
    expect((await search.timeline({ tokens })).map((b) => b.year)).toEqual([2022]);
    expect((await files.list({ pathPrefix: hidden })).items.map((f) => f.id)).toEqual([ids[2]]);
    expect((await files.timeline({ pathPrefix: hidden })).map((b) => b.year)).toEqual([2022]);

    config.patch({ libraries: [{ path: hidden, alias: "hidden", timeline: false }] });
    expect((await search.query({ tokens: [] })).items).toEqual([]);
    expect((await files.list({})).items).toEqual([]);
    expect(await search.timeline({ tokens: [] })).toEqual([]);
    expect((await search.query({ tokens })).items.map((f) => f.id)).toEqual([ids[2]]);
  } finally {
    config.patch({ libraries: previous });
    await db.file.deleteMany({ where: { id: { in: ids } } });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
