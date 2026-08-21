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

  const { watch } = await import("./server/services/config");
  watch();

  // thumbnail catch-up for any files missing thumbs
  const { db } = await import("./server/db");
  const { hasThumb, enqueueThumbs } = await import("./server/services/thumbs");
  const files = await db.file.findMany({
    select: { id: true, mediaType: true, paths: { select: { path: true }, take: 1 } },
  });
  enqueueThumbs(
    files
      .filter((f) => f.paths[0] && !hasThumb(f.id))
      .map((f) => ({ fileId: f.id, mediaType: f.mediaType, path: f.paths[0]!.path })),
  );

  const { startScheduler } = await import("./server/services/scheduler");
  startScheduler();

  const { bootMl } = await import("./server/services/ml");
  await bootMl();
}
