# refr

Self-hosted, single-user reference-image manager. Indexes read-only media libraries by
content hash, tags them hierarchically, and serves browse/search/queue/session/palette
workflows on top. See `refr.md` (vision) and `SPEC.md` (implementation spec).

## Run

```bash
npm install
npm run dev          # or: npm run build && npm start
```

Data directory resolution: `--data <dir>` flag > `DATA_DIR` env > `./data`.
First boot creates `config.yaml`, `refr.db`, `.secret`, and subdirs there.

Video thumbnails/probing require system `ffmpeg`/`ffprobe` on PATH (optional — without
them videos still index, just without thumbs/dimensions).

Semantic (CLIP) features are off by default; enable in Settings. Requires system
python ≥ 3.10 — first enable creates `data/ml-venv/` and downloads several GB
(torch + model weights).

## Test

```bash
npx vitest run       # service-level tests (search SQL, tags, scanner, sessions, palette, ml stub)
npm run check        # lint + typecheck
```
# refr
