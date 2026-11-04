# AGENTS.md

Self-hosted single-user reference-image manager. Single Next.js App Router package with tRPC + Prisma/SQLite; `refr/*` → `./src/*`. `refr.md` is the vision; `SPEC.md` is the design outline, but current code wins where it differs (notably auth, config defaults, and themes).

## Production vs. local

The real production instance runs on a **remote private server**. This working directory is a **small testing-only instance**, not a production deployment target. Its small dataset is not representative of production scale; keep media lists paginated/virtualized.

## Commands

- `npm run dev` — dev server (Turbopack, port 3000)
- `npm run check` — lint + typecheck (run before considering work done)
- `npx vitest run` — tests; `npx vitest run test/search.test.ts` for one file
- `npm run build && npm start` — local production-mode verification, not deployment to the remote server

**Gotcha:** dev and production-mode runs share `.next`. Stop dev and clear only `.next` (`rm -rf .next`) before building after a Turbopack dev run; its artifacts can break `next start`.

## Runtime data

Data directory resolution: `--data <dir>` flag > `DATA_DIR` env > `./data` (relative to the working directory, inside this checkout by default). Settings live in `config.yaml`; search metadata in `refr.db`; queues/sessions/saved searches/palettes in JSON files. Thumbnails are 2-hex sharded (`<id[0..2]>/<id>.webp`); use `thumbPath()` from `src/server/services/thumbs.ts`. `src/instrumentation.ts` applies migrations and starts background services at boot.

## Prisma quirks

- Client generates to `generated/prisma`, not `node_modules`; `postinstall` and `npm run build` regenerate it. For client-only generation use `npx prisma generate`; misleadingly, `npm run db:generate` runs `prisma migrate dev`.
- `Tag.name` has `COLLATE NOCASE` hand-edited into `prisma/migrations/000000000000_init/migration.sql`. Prisma can't express this; if you regenerate the migration, re-add it.
- Prisma CLI commands need `DATABASE_URL`; the app instead sets its datasource URL from the resolved data directory in `src/server/db.ts`. Do not assume the CLI and running app target the same database.

## Tests

All suites share ONE SQLite db (`/tmp/refr-vitest-data`, erased/recreated by `test/globalSetup.ts`) and run sequentially (`vitest.config.ts`). Do not run separate Vitest invocations concurrently. Scope assertions to your fixtures' IDs — other suites' rows exist. `test/setup.ts` sets `DATA_DIR`; `server-only` is aliased to `test/empty.ts` so services are importable. ML tests use an HTTP stub, not real Python/model downloads.

## Architecture notes that bite

- **Server/client boundary:** most services are `server-only`; do not import them into client components. Exception: `src/server/services/search.ts` deliberately contains client-safe token/SQL builders; DB execution is in `fileQuery.ts`. Put new shared constants/helpers in `src/lib/`.
- **Multiple module instances:** Next splits RSC / route handlers / instrumentation into separate module graphs, so module-level caches (config, scan progress) are per-instance. `config.get()` re-reads the file when its mtime changes — don't "optimize" that away.
- **Auth:** no middleware. `src/app/(app)/layout.tsx` guards pages; tRPC `protectedProcedure` guards the API; `/api/file/[id]` and `/api/thumb/[id]` use `requestAuthed()`. `passwordHash: null` in config = open app.
- **Search grammar:** `?q=` is the canonical **JSON-encoded token array**. `parseQuery`/`serializeQuery` are display/legacy forms, not lossless serialization (multi-word tags and similar-image chips).
- **File identity** = sha256 content hash; `FilePath` rows are attributes. Never write under a library path (only Send-to destinations may be written).
- `src/app/_components/media-grid.tsx` is the one grid used by browse/search/queue/similar — extend it rather than building a second grid.

## Optional system deps

`ffmpeg`/`ffprobe` on PATH for video thumbs/probing (absence degrades gracefully). CLIP is off by default; enabling it needs Python ≥ 3.10 with venv/pip, creates `ml/.venv/`, and downloads several GB of dependencies/model weights.

## Conventions

- Theme colors come from CSS custom properties in `src/styles/globals.css` (`[data-theme="x"]`); use the vars, not hard-coded colors. Theme IDs live in `src/lib/themes.ts`. Docs mention `mockups/`, but it is absent from this checkout.
- Bulk scans, thumbnail generation, and embeddings run in-process off request paths. No durable job tables; losing in-flight progress on restart is intentional.
- Deliberate simplifications are marked with `ponytail:` comments.
