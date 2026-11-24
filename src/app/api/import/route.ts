import { NextResponse } from "next/server";
import { requestAuthed } from "refr/server/services/requestAuth";
import { importLines, streamLines } from "refr/server/services/backup";

/** Merge a tags export (the raw .jsonl as the request body). Only adds. */
export async function POST(req: Request) {
  if (!(await requestAuthed())) return new NextResponse(null, { status: 401 });
  if (!req.body) return NextResponse.json({ error: "empty body" }, { status: 400 });
  const report = await importLines(streamLines(req.body));
  return NextResponse.json(report);
}
