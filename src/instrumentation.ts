export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initDataDir } = await import("./server/services/dataDir");
  initDataDir();

  // apply migrations (idempotent) — refr.db is created here on first boot
  const { execFile } = await import("node:child_process");
  const { paths } = await import("./server/services/dataDir");
  await new Promise<void>((resolve) => {
    execFile(
      "npx",
      ["prisma", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: `file:${paths.db}` } },
      (err, stdout, stderr) => {
        if (err) console.error("[migrate] failed:", err.message, stderr);
        else console.log("[migrate] ok:", stdout.trim());
        resolve();
      },
    );
  });

  // fallback: ensure SuggestionDenial table exists even if migration failed
  // (npx prisma can be absent in prod). Raw SQL via the already-connected client.
  const { db } = await import("./server/db");
  try {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SuggestionDenial" (
      "tagName" TEXT NOT NULL,
      "fileId" TEXT NOT NULL,
      CONSTRAINT "SuggestionDenial_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SuggestionDenial_tagName_idx" ON "SuggestionDenial"("tagName")`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "SuggestionDenial_tagName_fileId_key" ON "SuggestionDenial"("tagName", "fileId")`);
  } catch (e) {
    console.error("[schema] SuggestionDenial fallback failed:", e instanceof Error ? e.message : e);
  }

  const { watch } = await import("./server/services/config");
  watch();

  // thumbnail catch-up for any files missing thumbs. Migrate the flat layout
  // first so hasThumb() sees existing files instead of re-encoding everything.
  const { catchUpMissingThumbs, migrateThumbLayout, setOnThumbDrain } = await import("./server/services/thumbs");
  const { bootMl, enqueueEmbeddings } = await import("./server/services/ml");
  setOnThumbDrain(() => void enqueueEmbeddings());
  const moved = await migrateThumbLayout();
  if (moved > 0) console.log(`[thumbs] migrated ${moved} thumbnails into sharded subdirs`);
  void catchUpMissingThumbs().catch((e) => console.error("[thumbs] catch-up failed:", e));

  const { startScheduler } = await import("./server/services/scheduler");
  startScheduler();

  await bootMl();
}
