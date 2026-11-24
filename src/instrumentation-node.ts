/** Node-only boot (migrations, background services). Loaded from instrumentation.ts. */
export async function registerNode() {
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
  try {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "TagClassifier" (
    "tagId" INTEGER NOT NULL,
    "variant" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "weights" BLOB,
    "bias" REAL,
    "positives" INTEGER NOT NULL,
    "negatives" INTEGER NOT NULL,

    PRIMARY KEY ("tagId", "variant", "model"),
    CONSTRAINT "TagClassifier_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TagClassifier_variant_model_idx" ON "TagClassifier"("variant", "model")`);
  } catch (e) {
    console.error("[schema] TagClassifier fallback failed:", e instanceof Error ? e.message : e);
  }

  try {
    // mirrors prisma/migrations/20261117000000_tag_sweep (derived caches)
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "TagCandidate" (
    "tagId" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "score" REAL NOT NULL,
    "mode" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "rivalTag" TEXT,
    "rivalConfidence" REAL,
    "nearDenial" BOOLEAN NOT NULL,
    "sweptAt" DATETIME NOT NULL,
    PRIMARY KEY ("tagId", "fileId"),
    CONSTRAINT "TagCandidate_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TagCandidate_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TagCandidate_tagId_rank_idx" ON "TagCandidate"("tagId", "rank")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TagCandidate_fileId_idx" ON "TagCandidate"("fileId")`);
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "TagSweep" (
    "tagId" INTEGER NOT NULL PRIMARY KEY,
    "positives" INTEGER NOT NULL,
    "modes" INTEGER NOT NULL,
    "exemplars" TEXT NOT NULL,
    "sweptAt" DATETIME NOT NULL,
    CONSTRAINT "TagSweep_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
  } catch (e) {
    console.error("[schema] TagCandidate/TagSweep fallback failed:", e instanceof Error ? e.message : e);
  }

  try {
    // mirrors prisma/migrations/20261124000000_file_meta
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FileMeta" (
    "fileId" TEXT NOT NULL PRIMARY KEY,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "dhash" BIGINT,
    "duplicateOf" TEXT,
    "source" TEXT,
    "note" TEXT,
    "takenAt" DATETIME,
    "camera" TEXT,
    "exifChecked" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FileMeta_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "FileMeta_favorite_idx" ON "FileMeta"("favorite")`);
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "FileMeta_duplicateOf_idx" ON "FileMeta"("duplicateOf")`);
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "DuplicateDismissal" (
    "a" TEXT NOT NULL,
    "b" TEXT NOT NULL,
    PRIMARY KEY ("a", "b")
)`);
  } catch (e) {
    console.error("[schema] FileMeta/DuplicateDismissal fallback failed:", e instanceof Error ? e.message : e);
  }

  const { watch } = await import("./server/services/config");
  watch();

  // thumbnail catch-up for any files missing thumbs. Migrate the flat layout
  // first so hasThumb() sees existing files instead of re-encoding everything.
  const { catchUpMissingThumbs, migrateThumbLayout, setOnThumbDrain } = await import("./server/services/thumbs");
  const { bootMl, enqueueEmbeddings } = await import("./server/services/ml");
  const { registerSweepHooks } = await import("./server/services/sweep");
  registerSweepHooks();
  const { catchUpDhash } = await import("./server/services/duplicates");
  setOnThumbDrain(() => {
    void enqueueEmbeddings();
    void catchUpDhash().catch((e) => console.error("[dhash] catch-up failed:", e));
  });
  const moved = await migrateThumbLayout();
  if (moved > 0) console.log(`[thumbs] migrated ${moved} thumbnails into sharded subdirs`);
  void catchUpMissingThumbs().catch((e) => console.error("[thumbs] catch-up failed:", e));

  const { startScheduler } = await import("./server/services/scheduler");
  startScheduler();

  await bootMl();
}
