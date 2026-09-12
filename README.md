# Foreward

"I got tired of X, so I built Y". Today's subject: [Immich](https://github.com/immich-app/immich). 

This is a 100% vibe coded personal project to take what I liked from Immich and focus less on "normal users and families wanting a direct replacement for Google Photos" and more on managing/searching through a large library of unsorted images, particularly artwork. 

I aimed to improve the two main things Immich was and still is severly lacking in support: flexible and powerful searching, and streamlined tagging workflows. Additional features include a color palette manager (similar to [colorhunt](https://colorhunt.co/)), and other currently untested features (including an image queue for saving art/reference for study and a random session runner for drawing study)

With that out of the way, here's the current AI slop readme:

# refr

Self-hosted, single-user reference-image manager. Indexes read-only media libraries by
content hash, tags them hierarchically, and serves browse/search/queue/session/palette
workflows on top. See [refr](refr.md) (vision) and [SPEC](SPEC.md) (implementation spec).

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
