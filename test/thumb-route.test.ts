import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { thumbPath } from "refr/server/services/thumbs";

const auth = vi.hoisted(() => ({ allowed: true }));
vi.mock("refr/server/services/requestAuth", () => ({ requestAuthed: async () => auth.allowed }));
import { GET } from "refr/app/api/thumb/[id]/route";

const id = "ef" + "7".repeat(62);
const get = (fileId = id) => GET(new Request("http://localhost/api/thumb/" + fileId), { params: Promise.resolve({ id: fileId }) });

it("serves cached bytes and returns 404 when the thumbnail is absent", async () => {
  await fs.mkdir(path.dirname(thumbPath(id)), { recursive: true });
  await fs.writeFile(thumbPath(id), "cached-thumb");
  try {
    const response = await get();
    expect(await response.text()).toBe("cached-thumb");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await fs.rm(thumbPath(id));
    expect((await get()).status).toBe(404);
  } finally { await fs.rm(thumbPath(id), { force: true }); }
});

it("checks auth and validates ids before reading thumbnails", async () => {
  auth.allowed = false;
  try { expect((await get()).status).toBe(401); }
  finally { auth.allowed = true; }
  expect((await get("invalid")).status).toBe(400);
});

it("does not disguise unexpected read failures as missing thumbnails", async () => {
  const failure = Object.assign(new Error("disk failure"), { code: "EIO" });
  const read = vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
  try { await expect(get()).rejects.toBe(failure); }
  finally { read.mockRestore(); }
});
