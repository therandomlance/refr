import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { db } from "refr/server/db";
import { requestAuthed } from "refr/server/services/requestAuth";

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", tiff: "image/tiff",
  svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
  mov: "video/quicktime", avi: "video/x-msvideo",
};

/** Streams the original file with HTTP Range support (needed for video seeking). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await requestAuthed())) return new NextResponse(null, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(id)) return new NextResponse(null, { status: 400 });

  const file = await db.file.findUnique({
    where: { id },
    select: { paths: { select: { path: true } } },
  });
  const existing = file?.paths.map((p) => p.path).find((p) => fs.existsSync(p));
  if (!existing) return new NextResponse(null, { status: 404 });

  const stat = await fs.promises.stat(existing);
  const ext = path.extname(existing).slice(1).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      if (start < stat.size && start <= end) {
        const stream = Readable.toWeb(
          fs.createReadStream(existing, { start, end }),
        ) as ReadableStream;
        return new NextResponse(stream, {
          status: 206,
          headers: {
            "content-type": type,
            "content-range": `bytes ${start}-${end}/${stat.size}`,
            "accept-ranges": "bytes",
            "content-length": String(end - start + 1),
          },
        });
      }
    }
  }

  const stream = Readable.toWeb(fs.createReadStream(existing)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-length": String(stat.size),
    },
  });
}
