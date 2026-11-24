import { NextResponse } from "next/server";
import { requestAuthed } from "refr/server/services/requestAuth";
import { exportLines } from "refr/server/services/backup";

/** Tags, favorites, sources and notes as JSON lines (Settings → Backup). */
export async function GET() {
  if (!(await requestAuthed())) return new NextResponse(null, { status: 401 });
  const lines = exportLines();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next: IteratorResult<string, void> = await lines.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="refr-tags-${day}.jsonl"`,
      "cache-control": "no-store",
    },
  });
}
