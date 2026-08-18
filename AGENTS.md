# AGENTS.md

Self-hosted single-user reference-image manager. T3 stack: Next.js (App Router) + TS + tRPC + Prisma/SQLite + Tailwind. `refr.md` = vision, `SPEC.md` = authoritative implementation spec (section numbers referenced below). Single package, path alias `refr/*` → `./src/*`.

## Commands

- `npm run dev` — dev server (Turbopack, port 3000)
- `npm run check` — lint + typecheck (run before considering work done)
- `npx vitest run` — tests; `npx vitest run test/search.test.ts` for one file
- `npm run build && npm start` — production

**Gotcha:** dev and prod share `.next`, and Turbopack dev artifacts break `next start`. Always `rm -rf .next` before `npm run build`.

## Data directory (not the repo)

Runtime state lives outside the repo: `--data <dir>` flag > `DATA_DIR` env > `./data`. It holds `config.yaml` (all settings), `refr.db`, `thumbnails/`, `queues/`, `sessions/`, `searches/`, `palettes/` (plain JSON), `.secret`, `ml-venv/`. Migrations auto-apply at server boot via `src/instrumentation.ts`.

## Prisma quirks

- Client generates to `generated/prisma` (not node_modules) — import from `../../generated/prisma` in `src/server/db.ts`.
- `Tag.name` has `COLLATE NOCASE` hand-edited into `prisma/migrations/000000000000_init/migration.sql`. Prisma can't express this; if you regenerate the migration, re-add it.
- CLI commands need `DATABASE_URL` (`.env` has the default `file:./data/refr.db`); the app itself sets the datasource URL from the data dir at runtime.

## Tests

All suites share ONE sqlite db (`/tmp/refr-vitest-data`, recreated by `test/globalSetup.ts`) and run sequentially (`maxWorkers: 1`, `fileParallelism: false` in vitest.config.ts). Scope assertions to your own fixtures' ids — other suites' rows exist. `server-only` is aliased to `test/empty.ts` so services importable in vitest.

## Architecture notes that bite

- **Server/client boundary:** everything in `src/server/` is `server-only`. Client components importing a service file = build error. Shared constants go in `src/lib/` (e.g. `themes.ts`).
- **Multiple module instances:** Next splits RSC / route handlers / instrumentation into separate module graphs, so module-level caches (config, scan progress) are per-instance. `config.get()` re-reads the file when its mtime changes — don't "optimize" that away.
- **Auth:** no middleware. `src/app/(app)/layout.tsx` guards pages server-side; tRPC `protectedProcedure` guards the API; `/api/file|thumb/[id]` check the cookie themselves. Password null in config = open app.
- **Search grammar:** `?q=` URL param is the **JSON-encoded token array**, canonical. `parseQuery`/`serializeQuery` pretty-string form is display/legacy only and can't express multi-word tags unquoted — that's deliberate (SPEC §9.2).
- **File identity** = sha256 content hash; `FilePath` rows are attributes. Never write under a library path (only Send-to destinations may be written).
- `src/app/_components/media-grid.tsx` is the one grid used by browse/search/queue/similar — extend it rather than building a second grid.

## Optional system deps

`ffmpeg`/`ffprobe` on PATH for video thumbs/probing (absence degrades gracefully). Python ≥ 3.10 for the CLIP sidecar (`ml/`, off by default; venv auto-created at `data/ml-venv/` on first enable).

## Conventions

- Plain CSS with per-theme custom properties in `src/styles/globals.css` (`:root[data-theme="x"]`); components use the vars, no hard-coded colors. Theme values come from `mockups/theme-*.css` — port, don't reinvent. `mockups/` is reference-only, do not build from it (excluded from tsconfig).
- Background jobs (scan, thumbs, embeddings) are in-process FIFOs, never in request paths. No job tables — restart losing progress is fine.
- Deliberate simplifications are marked with `ponytail:` comments.
