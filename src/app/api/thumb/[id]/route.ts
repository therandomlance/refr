import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { requestAuthed } from "refr/server/services/requestAuth";
import { thumbPath } from "refr/server/services/thumbs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await requestAuthed())) return new NextResponse(null, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(id)) return new NextResponse(null, { status: 400 });
  const file = thumbPath(id);
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new NextResponse(null, { status: 404 });
    }
    throw error;
  }
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
