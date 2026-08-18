# refr — Implementation Spec

Derived from `refr.md`. This document is the authoritative outline for implementing the app.
Sections are ordered so they can be implemented roughly top-to-bottom; each section lists its
dependencies on earlier sections.

---

## 1. Overview

Self-hosted, single-user reference-image manager. Next.js (App Router) + TypeScript + tRPC +
Prisma (SQLite) + Tailwind (T3 boilerplate, already initialized). No upload/store of media:
the app indexes user-declared **read-only libraries** by content hash, tags them, and serves
search/browse/view on top. Scale target: 100k files now, 1M design ceiling.

**Hard rules (apply everywhere):**
- Never write to library paths. The only writes outside the data dir are Send-to destinations.
- File identity = sha256 of content. Paths are attributes, not identity.
- No unbounded result sets in memory. Everything paginated/keyset-cursored/virtualized.
- All lists/grids share one component set (§10).

## 2. Data directory & configuration

Depends on: nothing. Implement first; everything else reads it.

### 2.1 Layout

```
data/
  config.yaml
  refr.db            # Prisma SQLite
  .secret            # 32-byte random hex, created on first boot (chmod 600)
  thumbnails/        # <file-id>.webp
  queues/
    active.json      # the single live queue (hidden from "saved queues" UI)
    <name>.json      # saved queues
  sessions/
    <name>.json      # session template
    <name>.history.json  # one history file per template
  searches/          # saved searches, one JSON file each: <name>.json
  palettes/
    <folder>/<name>.json   # subfolders = palette folders
  ml-venv/           # python venv for the CLIP sidecar, auto-created on first enable (§13)
```

- Location resolved at server boot: CLI flag `--data <dir>` > env `DATA_DIR` > `./data`.
- Boot routine (`src/server/services/dataDir.ts`): mkdir -p all subdirs, create `.secret` if missing.

### 2.2 config.yaml shape

```yaml
passwordHash: null            # "scrypt:N:r:p:salt:hash" or null = open app
libraries: []                 # absolute paths
scanTime: "03:00"             # HH:MM or null = disabled
defaultThumbnailSize: medium  # small|medium|large
skipTagRemoveConfirm: false
sendToPaths: []               # absolute paths
sessionHistoryCap: 1000
theme: slate                  # slate|paper|ember|forest|velvet|mono
ml:                           # see §13.9
  enabled: false
  port: 3777
  model: "ViT-B-16-SigLIP2"
  pretrained: "webli"
  tagSuggestionTextWeight: 0.5
  tagSuggestionMinScore: 0.25
```

### 2.3 Config service (`src/server/services/config.ts`)

- `get()` returns a cached parsed object; `patch(partial)` validates (zod), deep-merges, writes
  YAML atomically (tmp + rename), updates cache.
- `fs.watch` (debounced 500 ms) reloads on external edits so UI and file reflect each other.
- All settings reads/writes anywhere in the app go through this service. No other code parses
  config.yaml.
- Dependency: `yaml` package. No other new deps here.

## 3. Auth

Depends on: §2.

- Single user. No registration, no accounts, no NextAuth.
- Password stored as `scrypt` hash (node `crypto`, format above) in config. Timing-safe compare.
- Session: signed cookie `refr_session` = `expiryTimestamp.hmac`, HMAC-SHA256 keyed with
  `data/.secret`. 30-day expiry, `httpOnly`, `sameSite=lax`.
- `src/server/services/auth.ts`: `setPassword`, `verifyPassword`, `createSession`,
  `verifySession`, `isOpen()` (true when `passwordHash` is null).
- Enforcement: tRPC context (§8) rejects unauthenticated calls; `src/middleware.ts` redirects
  unauthenticated page requests to `/login`. When `isOpen()`, all checks pass through.
- Login page: `/login`, one password field, sets cookie on success.

## 4. Database schema (Prisma)

Depends on: §2. Replace boilerplate `prisma/schema.prisma`.

```prisma
model File {
  id        String    @id              // sha256 hex
  size      BigInt
  mtime     DateTime                   // from best-known path; grouping/sorting key
  width     Int?
  height    Int?
  duration  Float?                     // seconds, video only
  mediaType String                     // "image" | "video"
  addedAt   DateTime  @default(now())
  paths     FilePath[]
  tags      FileTag[]

  @@index([mtime, id])                 // keyset pagination for default sort
  @@index([mediaType])
}

model FilePath {
  id     Int    @id @default(autoincrement())
  path   String @unique
  fileId String
  file   File   @relation(fields: [fileId], references: [id], onDelete: Cascade)

  @@index([fileId])
}

model Tag {
  id    Int       @id @default(autoincrement())
  name  String    @unique
  files FileTag[]
}

model FileTag {
  fileId String
  tagId  Int
  file   File @relation(fields: [fileId], references: [id], onDelete: Cascade)
  tag    Tag  @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([fileId, tagId])
  @@index([tagId, fileId])
}
```

Plus the semantic-feature tables (`FileEmbedding`, `TagVector`, `Meta`) defined in §13.3.

**Collation:** tag names compare case-insensitively. Prisma can't express collation, so the
initial migration is edited to add `COLLATE NOCASE` on `Tag.name` (uniqueness + comparisons).
Keep `tags.ts` helpers normalizing input with `.trim().toLowerCase()` as belt-and-suspenders;
display uses the stored form.

Prisma client output stays default. `db.ts` boilerplate retained; add
`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` at client construction.

## 5. Scanner

Depends on: §2, §4.

`src/server/services/scanner.ts`. Runs as an in-process background job (§12); never in a
request path.

### 5.1 Formats

- Images: jpg, jpeg, png, gif, webp, avif, bmp, tiff, svg.
- Video: mp4, webm, mkv, mov, avi.
- One exported `EXTENSIONS` map → mediaType; scanner ignores everything else.

### 5.2 Scan algorithm (per library, sequential libraries)

1. **Walk** the library recursively (`fs/promises` + `withFileTypes`, depth-first generator —
   never `readdir` a whole tree into memory). Yield `{path, size, mtime}` for known extensions.
2. **Reconcile known paths:** for each `FilePath` under this library root, `stat`:
   - missing → delete the `FilePath` row (file row stays; purge is a separate Settings action);
   - size or mtime changed → re-hash (step 4).
3. **Classify walked paths** against the DB (`FilePath.path` unique index):
   - known & unchanged → skip;
   - unknown → hash (step 4).
4. **Hash** sha256 via `crypto.createHash` stream (64 KiB chunks, never read whole file).
   Then one of:
   - hash unknown → create `File` (probe dimensions/duration, §5.3) + `FilePath`;
   - hash known, path new → attach `FilePath` to the existing `File` (dedupe/renames);
   - hash known but the walked file's *old* row had a different hash → move path: detach from
     old `File`, attach to the hash's `File`. (Content changed in place.)
5. **Update mtime** on `File` to the max mtime across its current paths after each scan.
6. Enqueue thumbnail jobs (§6) for any `File` lacking `thumbnails/<id>.webp`, then
   embedding jobs (§13.2) for any `File` lacking a current-model embedding (skipped
   entirely when `ml.enabled` is false or the sidecar isn't ready).
7. After all libraries: delete `FilePath` rows whose path no longer stats, for paths outside
   currently configured libraries too (library removed from config).

Progress: in-memory `{running, phase, processed, total}` singleton, exposed via tRPC for the
Settings UI to poll (2 s interval while running). No job table — restart loses progress,
which is fine; scans are idempotent.

**Purge** (Settings action, separate from scan): delete `File` rows having zero `FilePath`s
(+ their thumbnails). Confirmation dialog states the count.

### 5.3 Probing

- Images: `sharp(path).metadata()` → width/height. (sharp added for thumbnails anyway.)
- Video: `ffprobe -v quiet -print_format json -show_format -show_streams` (system binary,
  spawn, JSON parse) → width/height/duration. ffmpeg/ffprobe is a documented external
  dependency; absence → video rows still index, thumbnails/dimensions just skipped.

## 6. Thumbnails

Depends on: §5.

`src/server/services/thumbs.ts`. In-process FIFO queue, concurrency 2 (`p-limit`-style
hand-rolled loop, no dep), drained after scans and at boot (catch-up for missing thumbs).

- Image: `sharp(path).resize(512, 512, {fit: 'inside', withoutEnlargement: true}).webp({quality: 80})`
  → `thumbnails/<id>.webp`.
- Video: `ffmpeg -ss 10%*duration -i <path> -frames:v 1` to a tmp png → same sharp pipeline.
  Fallback to `-ss 0` if the seek yields nothing.
- Serving: `GET /api/thumb/[id]` streams the webp, `Cache-Control: immutable`. Missing thumb →
  404; client renders a placeholder tile.
- Originals: `GET /api/file/[id]` resolves the first existing `FilePath` and streams it with
  **HTTP Range support** (required for HTML5 video seeking). `Content-Type` from extension.
  Auth-checked. 404 if no path currently exists (unmounted drive).

## 7. Tags

Depends on: §4.

### 7.1 Model

Hierarchical, `/`-separated, stored flat in `Tag.name` — hierarchy is derived from the string,
never a parent FK. `src/server/services/tags.ts`:

- `normalize(name)`: trim, collapse repeated `/`, strip leading/trailing `/`, lowercase for
  comparisons only.
- `ancestors(name)`: `a/b/c` → `[a, a/b, a/b/c]`.
- `descendantFilter(name)` → Prisma `OR: [{name}, {name: {startsWith: name + '/'}}]`.

### 7.2 Tagging operations (tRPC `tags` router)

- `setTags(fileIds[], add[], remove[])` — bulk add/remove, create `Tag` rows on demand,
  dedupe via `@@id([fileId, tagId])` upsert-skip.
- `rename(old, new)` — update the tag and **rewrite every descendant** (`a/b` → `x/y` for all
  `a/b/*`) inside one transaction; merge collisions by deleting duplicate `FileTag`s.
- `merge(source[], target)` — repoint all links to target, dedupe, delete sources.
- `delete(name)` — delete tag + all descendants (links cascade via FileTag rows first).
- `tree()` — returns the full tag list with **counts including descendants**. Algorithm:
  one query for direct counts (`FileTag.groupBy(tagId)`), one for all tag names, then in JS
  walk each tag's ancestor chain adding its count to every prefix. O(tags × depth), no N+1.
  Used by Browse (filter to count ≥ 1) and autocomplete.
- `search(prefix, limit 20)` — fuzzy autocomplete: `LIKE '%term%'` on name ordered by
  `count desc` (precomputed in memory from `tree()` cache, 5 s TTL).

## 8. tRPC API surface

Depends on: §3, §4. `src/server/api/root.ts` replaces the boilerplate `post` router.

| Router | Procedures |
|---|---|
| `auth` | `login`, `logout`, `status` |
| `files` | `list` (shared cursor query, §9.4), `byId`, `sendTo(id, destIndex)`, `purgeOrphans`/`countOrphans`, `purgeExternal`/`countExternal`, `purgeOrphanThumbs` |
| `tags` | §7.2 + `forFiles(fileIds[])` (intersection for viewer/multi-select) |
| `search` | `query(tokens, sort, cursor)` (§9; routes through §13.5 when a text chip is present), `autocomplete(term)` |
| `ml` | `status`, `setEnabled`, `similar(fileId)`, `suggestImagesForTag(tag)`, `suggestTagsForFile(fileId)`, `reembedAll` (§13.8) |
| `searches` | saved searches: `list`, `save(name, tokens, sort)`, `delete(name)`, `rename(old, new)` |
| `browse` | `folderTree()` (top-level = libraries, lazy children), `tagTree()` (§7.2 `tree`), `children(node)` |
| `queue` | `get`, `set(fileIds[])` (reorder/add/remove all go through one setter), `clear`, `save(name)`, `listSaved`, `load(name)`, `deleteSaved(name)` |
| `sessions` | template CRUD (`list/get/save/delete`), `generate(templateId)` (§11.4), `history(templateId)`, `replay(templateId, historyIndex)`, `renameTemplate` |
| `palettes` | `list` (walks `data/palettes/` incl. folders; returns `{items, folders}`), `save`, `delete`, `extract(fileId, n)` (§11.5), `move(name, folder)`, `createFolder`, `renameFolder`, `deleteFolder` |
| `settings` | `get`, `patch` (→ config service), `scanNow`, `scanStatus`, `thumbStatus`, `setPassword`, `clearPassword` |

Context: session check (§3); public procedures only `auth.login`/`auth.status`. All inputs
zod-validated. Plaintext-backed routers (queue/sessions/searches/palettes) are thin over
`src/server/services/{queue,sessions,searches,palettes}.ts` — JSON files read/written per
call, schemas validated with zod on both directions.

## 9. Search

Depends on: §7. The algorithmic core; implement with tests (§15).

### 9.1 Token model

```ts
type Token = {
  kind: "tag" | "text" | "similar";  // "text" = semantic free-text (§13.5); "similar" = find-similar seed (§13.6). Max 1 vector chip per query.
  tag: string;                     // raw tag/pattern, metadata keyword, text value, or fileId (similar)
  negate: boolean;                   // leading -   (tag chips only)
  exact: boolean;                    // leading =   (tag chips only)
  or: boolean;                       // leading ~   (tag chips only)
  wildcard: boolean;                 // contains *
};
```

### 9.2 Grammar (string form, for URLs/sharing)

```
term      := ("-" | "~")* "="? body
body      := tag path, possibly containing "*"
query     := term (" " term)*        // space-separated; chips make spaces-in-tags unambiguous
```

- Modifier order: `-`/`~` first (either order tolerated), then `=`.
- Parse: `parseQuery(string) → Token[]`; serialize: `serializeQuery(Token[]) → string`.
  Round-trip is lossless except whitespace. Tag bodies containing spaces serialize verbatim —
  splitting happens only at chip boundaries client-side, so a naive `split(" ")` is **wrong**
  for multi-word tags. Canonical rule: a space terminates a body only if the remainder parses
  as a new term start (starts with `-`/`~`/`=` or matches a known tag prefix); otherwise it's
  part of the body. **Simpler rule (chosen):** the URL format is the chip list JSON-encoded in
  `?q=`; the pretty string form is display-only. No ambiguous parser needed.
- Wildcard terms: no implicit descendant expansion (`*` already matches `/`).

### 9.3 SQL translation (`src/server/services/search.ts`)

Raw parameterized SQL via `Prisma.sql` (Prisma's `startsWith` can't express mid-tag wildcards,
and per-term EXISTS clauses compose better in SQL):

```sql
SELECT f.* FROM File f
WHERE
  -- positive non-OR terms: one per term
  EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
          WHERE ft.fileId = f.id AND <tagCond(t.name, term)>)
  AND ...
  -- OR group (all ~terms collected into one clause)
  AND (EXISTS (... <cond termA>) OR EXISTS (... <cond termB>) ...)
  -- negated terms
  AND NOT EXISTS (... <cond term>)
```

`<tagCond>`:
- exact: `t.name = ?`
- normal (descendants): `t.name = ? OR t.name LIKE ? ESCAPE '\'` with `tag + '/%'`
- wildcard: `t.name LIKE ? ESCAPE '\'` with `*`→`%`, and literal `%`/`_`/`\` escaped.

Metadata keywords, registry pattern (`KEYWORDS: Record<string, (b: Builder) => void>`):
- `untagged` → `NOT EXISTS (SELECT 1 FROM FileTag WHERE fileId = f.id)`.
- Extensible by adding entries; unknown keyword → treated as a literal tag.

Grouping OR: consecutive `~` tokens form one OR group (booru convention).

### 9.4 Shared list query (used by search, browse, queue-of-results)

One builder: `fileQuery({where: FileWhere, sort, cursor, limit})`.

- Sorts: `date` (`mtime DESC, id DESC`, keyset cursor `(mtime, id)`), `name` (basename of
  first path — denormalize `FilePath` ordering by `path` asc), `size`, `random`.
- Keyset pagination for `date` (the default and hottest path); `LIMIT/OFFSET` for name/size
  (acceptable; offsets stay small in practice). Random: `ORDER BY RANDOM()` with a per-request
  seed token; duplicates across pages accepted (ponytail: fine for browsing; revisit if it
  annoys anyone).
- Page size 200. Response = `{items: FileSummary[], nextCursor}`. `FileSummary` =
  `{id, mediaType, width, height, duration}` — grids need nothing else.

## 10. Shared UI architecture

Depends on: §8. Implement before any page; pages are thin compositions.

### 10.1 Routes/layout

```
/login
/search            (default landing)
/browse
/queue
/sessions          + /sessions/[name] (edit) + run mode overlay
/palettes
/settings
```

Root layout: fixed icon rail (left edge, ~56 px) + page content. Sidebar-inside-page pattern
per tab. Dark theme default, minimal, Tailwind only (no component lib — headless needs are
small; build `Dialog`, `ContextMenu`, `Tree` as small local components).

### 10.2 Shared components (`src/app/_components/`)

- **`<MediaGrid>`** — the one grid. Props: `{queryInput, selection, actions}`. Internally:
  - infinite scroll over §9.4 via tRPC `useInfiniteQuery`;
  - **virtualized rows** (`@tanstack/react-virtual` — added dep, justified by 1M scale);
  - layouts: `waterfall-vertical` (CSS columns, column count from tile size) and
    `waterfall-horizontal` (justified rows, Immich-style: partition a row so Σ aspect ratios
    ≈ row width — linear scan, no fancy partition algorithm needed);
  - thumbnail size s/m/l (default from config; user changes persist back to config);
  - sorting (date/name/size/random) and grouping (day/month/year headers by `mtime`) controls;
    groups that fit on one row at natural height are packed together (larger gap, header
    label over each group's segment); oversized groups get full-width justified rows of
    their own. Day labels are `Tue, Aug 11` (no year). Tiles get a few px padding per side;
  - selection: click (toggles while a selection exists; viewer opens only when nothing is
    selected), shift-range, ctrl-toggle, click-drag range (text selection suppressed), Esc
    clears; group headers have a select-all bubble per segment; toolbar shows "N selected" +
    Select-all + a ⋮ menu (bulk tag add/remove); selection state lifted to page.
- **`<Viewer>`** — fullscreen overlay, opened with `?v=<fileId>&ctx=<queryKey>` so it's
  linkable and knows the surrounding list for prev/next. Contents:
  - image: original via `/api/file/[id]`; video: `<video controls>`;
  - left collapsible panel: metadata (paths, size, dims, duration, dates) + file options;
  - right collapsible panel: tag manager — `<TagInput>` (§10.3) for adds, tag chips with [X]
    (confirm unless `skipTagRemoveConfirm`); below it, "Suggested tags" chips
    (`ml.suggestTagsForFile`, §13.7) — click to add;
  - bottom collapsible carousel: thumbnails of surrounding items, click to jump;
  - keyboard: ←/→ navigate, Esc close, `f` toggle panels.
- **`<ContextMenu>`** actions (shared by grid + viewer): Add to queue, Remove from queue,
  Create palette, Send to → (submenu of configured destinations), Find similar (§13.6,
  hidden when ML unavailable), Tag actions (add/remove bulk).
- **`<Tree>`** — lazy expandable tree used by Browse (folders + tags).
- **Tag chip & autocomplete primitives** — shared by Search bar, viewer tag manager, session
  editor.

### 10.3 `<TagInput>`

Text input + dropdown of `tags.search` results (debounced 150 ms), keyboard navigable,
Enter commits. Used in three places: search chips (with `-`/`~`/`=` prefix parsing while
typing), viewer tagging, session template rows.

### 10.4 Theming

**Layout is decided: Classic** (rail + sidebar + justified grid + overlay viewer, as specced in
§10.1–10.2). The Dock/Studio mockups in `mockups/` are rejected concepts kept for reference —
do not build them.

**Color theme is a runtime setting** (`theme` config key, settable in Settings, live-switch,
no reload). Six themes, each a color *and* density package (colors + radius/gap/row-height):

| Theme | Character |
|---|---|
| `slate` (default) | dark neutral, blue accent |
| `paper` | light warm cream, rust accent, serif group headers |
| `ember` | near-black, orange accent, compact |
| `forest` | green-tinted dark, moss accent |
| `velvet` | deep purple dark, violet accent |
| `mono` | pure grays, white accent |

Implementation: all visual values are CSS custom properties (`--bg`, `--panel`, `--border`,
`--hover`, `--active`, `--text*`, `--accent*`, `--radius`, `--tile-radius`, `--gap`,
`--row-h`, `--head-*`, `--shadow-sm`) declared per theme as `:root[data-theme="x"]` blocks
in `globals.css`; Tailwind utilities reference the vars (`bg-(--panel)` etc.), so components
contain zero hard-coded colors. The root layout reads `theme` from config server-side and
renders `<html data-theme="…">` — no flash of wrong theme.

Reference mockups live in `mockups/` (`index.html` links all themes on the Classic layout);
the theme CSS files there are the source of truth for the var values — port them verbatim
into `globals.css` blocks.

## 11. Pages

### 11.1 Browse (`/browse`)

Depends on: §10.

- Toggle: Folders | Tags.
- Folders: `<Tree>` rooted at each configured library; lazy-load children via
  `browse.children`. Grid at root = library cards only. Selecting a node lists files
  **directly in that folder** (unlike tags, subfolder files are excluded; §9.4
  where-clause); child folders render as cards atop the grid, double-click descends.
  Read-only.
- Tags: `<Tree>` from `browse.tagTree` (count badges, tags with 0 files hidden). Selecting a
  node lists files tagged with it-or-descendants; child tags as cards. Management actions on
  right-click: rename / merge / delete (global, confirmation dialog showing affected-file
  count from the tree cache).
- **Suggested strip** (requires §13): when a tag node is selected, a collapsible
  "Suggested for this tag" strip above the grid shows `ml.suggestImagesForTag` results.
  Tiles have a quick-accept ✓ (adds the tag, removes the tile) plus normal click → viewer.

### 11.2 Search (`/search`)

- Chip bar: tokens per §9.1, modifiers shown on chip (`-`, `~`, `=` badges), [X] and
  Backspace remove, Enter commits autocomplete highlight. When no tag matches the input,
  the autocomplete's last row is "Semantic: '&lt;input&gt;'" — commits a text chip
  (§13.5; hidden when ML is unavailable). Chip list ↔ `?q=` URL param
  (JSON form §9.2) for shareability.
- Results: `<MediaGrid>` fed by `search.query`.
- Everything else (viewer, selection, context actions) comes free from §10.

**Saved searches** — plaintext JSON in `data/searches/<name>.json`:

```json
{
  "name": "figure studies",
  "tokens": [{"tag": "reference/figure", "negate": false, "exact": false, "or": false, "wildcard": false}],
  "sort": "date"
}
```

- Token objects use the §9.1 model verbatim — load = replace chip list; no parsing needed.
- Search-page sidebar lists all saved searches (name + pretty string form §9.2). Click to
  load into the chip bar (and `?q=`). Current query saves via a "Save search" button (name
  prompt; overwrite confirm on collision). Rename/delete via context menu on the list item.
- `sort` is optional; defaults to `date` when absent.

### 11.3 Queue (`/queue`)

- Server state: `data/queues/active.json` = `{fileIds: string[]}` — single active queue,
  shared across devices (single-user app).
- `queue.set` handles add/remove/**reorder** (client sends whole ordered id array; drag-and-
  drop reorder in the grid via HTML5 DnD, no lib).
- Add/remove available from every context menu (§10.2).
- Clear (confirm), Save-as (name → `<name>.json`), saved list, load (replaces active after
  confirm if non-empty), delete saved.
- Grid = `<MediaGrid>` in "explicit ids" mode (order = queue order, no sort control).

### 11.4 Sessions (`/sessions`)

Template JSON (`data/sessions/<name>.json`):

```json
{
  "name": "figures",
  "blocks": [
    {"tag": "reference/figure", "count": 10, "seconds": 120, "autoScroll": true},
    {"tag": "reference/hands", "count": 5, "seconds": null, "autoScroll": false}
  ]
}
```

History JSON (`<name>.history.json`): `[{date, blocks: [{tag, fileIds: []}]}]` newest-first,
truncated to `sessionHistoryCap` on append.

- **Editor:** rows matching the spec sketch — tag input (autocomplete) | count | time
  (mm:ss, optional) | auto-scroll checkbox (disabled unless time set) | [X]; "+ Add row";
  drag to reorder. Save → template file. Rename = `sessions.renameTemplate` (renames history
  file too).
- **Generate** (`sessions.generate`, server): for each block in order, resolve tag +
  descendants → distinct file ids, `ORDER BY RANDOM() LIMIT count`, excluding ids already
  drawn earlier in the same session. Append history entry (truncate to cap). Returns the
  expanded run.
- **Run mode:** fullscreen `<Viewer>` reuse; per current block, timer overlay when
  `seconds` set; auto-scroll advances on expiry, otherwise flash indicator; snooze buttons
  +30s/+1m/+5m/+10m **add** to remaining time. Mixed timed/untimed blocks just work (no
  timer shown for untimed). End → summary screen (per-block counts, total time, "replay this
  session" button).
- **History list** under each template: pick an entry → replay as a live run (same engine,
  fixed ids, no new history entry).

### 11.5 Palettes (`/palettes`)

Palette JSON: `{name, colors: ["#rrggbb", ...], sourceFileId?}` (1–10 colors, default 4),
file-per-palette, subfolders = folders. `sourceFileId` is the image the palette was
extracted from (when any); the editor's eyedropper fallback re-references it on later edits,
and the viewer shows its thumbnail.

- Grid of palette cards (colorhunt-style vertical stripes), folder sidebar, sort by
  name/date. Copy hex on swatch click. Export PNG: client-side `<canvas>` striped square →
  download (no server code).
- Double-click a card opens the combined palette panel (wide dialog: name/folder, then
  full-height preview stripes beside the referenced image; each stripe row carries the hex
  code plus inline copy/edit-hex/eyedropper/remove buttons; stripes compress as colors are
  added). PNG export draws the hex codes on the stripes like the preview.
  Sidebar: folders (incl. empty), "+ Folder" button, drag cards onto folder rows to move,
  right-click folders for rename/delete (delete moves contents to unfiled).
- Saving with a taken name appends ` (N)` instead of overwriting; editing an existing
  palette in place (same name+folder) overwrites, renaming/moving removes the old file.
- **Extract from image** (context action, `palettes.extract`): server-side, sharp → raw RGB
  at ≤128 px, **median-cut** quantization to N buckets (deterministic, ~40 lines, no dep):
  recursively split the channel with greatest range at the median, average each bucket,
  sort output by luminance. Returns colors; UI opens the editor.
- **Editor:** swatch list (add/remove up to 10), rename, choose folder. Eyedropper override:
  show the source image on a canvas, click samples the pixel (use the `EyeDropper` API where
  available, canvas click fallback). Save → JSON file; move between folders via drag or
  `palettes.move`.

### 11.6 Settings (`/settings`)

Form bound to `settings.get`/`settings.patch` (every field from §2.2), plus:
- Scan: time field (or "off"), "Scan now" button, live progress bar polling `scanStatus`,
  plus thumbnail-queue progress polling `thumbStatus`.
- Background activity: one compact card listing whatever is running (scan, thumbnails, ML
  embeddings/sidecar); "Idle" otherwise.
- Purge orphans: button + count preview + confirm. Remove images outside all libraries:
  button + count preview + confirm. Clear orphaned thumbnails (cached `<id>.webp` with no
  File row): button + confirm.
- Password: set/change/clear (three fields, current-password check when one is set).
- Libraries: path list editor (add/remove; remove warns that files stay in DB until purge
  or vanish-prune).
- Send-to destinations: path list editor.
- Appearance: theme picker (6 swatches, §10.4); applies live via `settings.patch`.
- **Semantic / ML** (§13): enable toggle (validates python, runs bootstrap with a progress
  log: venv → deps → model download → load), status card (device, model, `embedded x/y`,
  sidecar health), the two calibration knobs (`tagSuggestionTextWeight`,
  `tagSuggestionMinScore`), and "Re-embed all" (confirm; required after model change).

### 11.7 Send-to (context action)

`files.sendTo`: copy the file's first existing path into the chosen destination. Collision →
`name (1).ext`, `name (2).ext`, … (`fs.existsSync` loop, cap 999). Only configured
`sendToPaths` are valid targets (server-validated — this is the sole write outside the data
dir, keep the validation strict).

## 12. Scheduler & jobs

Depends on: §5, §6.

- `instrumentation.ts` `register()` (Next.js server-start hook): init data dir, open DB,
  run thumbnail catch-up, start the scan scheduler.
- Scheduler: compute next `scanTime` occurrence, `setTimeout`, re-arm after each run. No
  cron dep. Changing `scanTime` in config re-arms (config service emits an event).
- `scanNow` sets the same job running; concurrent triggers coalesce (single-flight guard).

## 13. Semantic (CLIP) features

Depends on: §4, §5, §9. Covers natural-language search, similar-image search, and tag
suggestions — all from one embedding model. Every feature in this section degrades
gracefully: when the model is disabled or unhealthy, the UI hides it and the rest of the
app is unaffected.

### 13.1 Model & sidecar

- Model: **open_clip `ViT-B-16-SigLIP2`, pretrained `webli`** (same weights as
  immich-app/ViT-B-16-SigLIP2__webli), via [open_clip](https://github.com/mlfoundations/open_clip)
  (handles tokenizer + preprocessing). 768-dim embeddings, stored L2-normalized →
  cosine similarity = dot product.
- Runtime: Python sidecar living in `ml/` at repo root (`server.py`, `requirements.txt`:
  torch, open_clip_torch, fastapi, uvicorn, pillow, numpy). FastAPI, one process, model
  loaded once at startup; device auto (CUDA if present, else CPU).
- **App-managed, not user-managed.** When `ml.enabled`, the Next server
  (instrumentation.ts) ensures a venv at `data/ml-venv/` (create + pip install on first
  run), spawns the sidecar as a child process, restarts on crash (3 tries, backoff), and
  polls `/health`. Requires system python ≥ 3.10 with venv+pip — validated when the user
  flips the toggle, with a clear error if missing. First enable downloads several GB
  (torch wheels + model weights); Settings shows bootstrap progress. Sidecar binds
  localhost only.
- Sidecar HTTP API:
  - `GET /health` → `{status: "booting"|"loading"|"ready", device, model}`
  - `POST /embed/text` `{texts: string[]}` → vectors
  - `POST /embed/image` `{paths: string[]}` (thumbnails — already webp ~512px, exactly the
    right input) → vectors
  - `POST /knn` `{vector, k, skip, excludeTag?}` → `[{fileId, score}]`
  - Vectors on the wire: raw float32-LE binary or base64; JSON float arrays only for
    single-vector calls.
- **kNN lives in the sidecar.** It opens `<data>/refr.db` read-only (WAL allows concurrent
  readers), caches the full embedding matrix + id list in RAM, and rebuilds the cache when
  `(COUNT(*), MAX(updatedAt))` of `FileEmbedding` changes (checked per request — one cheap
  query). Brute force: `scores = M @ q`, `argpartition` top-k. <100 ms at 100k files.
  Also caches a `TagVector` matrix (for §13.7) rebuilt on `linksVersion` change.
  <!-- ponytail: full matrix in RAM — ~300 MB at 100k, ~3 GB at 1M. If that bites: int8
       quantize the cached matrix, or move the store to sqlite-vec. -->
- `excludeTag`: sidecar excludes files having that tag or any descendant via one SQL read
  against the same DB (it's the one tag-filter it knows; all other filtering is Node-side).

### 13.2 Embedding pipeline

- One `FileEmbedding` row per file. Generated as a scan step (§5.2, after thumbnails) for
  files lacking a current-model embedding, batches of 32, plus boot catch-up, plus on-demand
  single embed when `similar` targets an unembedded file. Background only, never in a
  request path; expect hours per 100k images on CPU, much faster on GPU.
- Model identity (`model` + `pretrained`) stored per row. Changing the model in config →
  rows are stale → Settings exposes "Re-embed all" (drops and regenerates).

### 13.3 Schema additions (§4)

```prisma
model FileEmbedding {
  fileId    String   @id
  vector    Bytes              // 768 × float32 LE, L2-normalized
  model     String
  updatedAt DateTime @updatedAt
  file      File     @relation(fields: [fileId], references: [id], onDelete: Cascade)
}

model TagVector {
  tagId        Int    @id
  vector       Bytes           // combined text+centroid, L2-normalized
  fileCount    Int
  linksVersion Int
  model        String
  tag          Tag    @relation(fields: [tagId], references: [id], onDelete: Cascade)
}

model Meta {
  key   String @id
  value String               // "linksVersion": int, bumped by every tag-link mutation
}
```

### 13.4 Combined query vector for a tag (the merge algorithm)

```
v = normalize( w_text · textEmb(prettify(tag)) + w_img · centroid(images) )
```

- `prettify`: path segments joined with spaces (`reference/figure/arms` →
  `"reference figure arms"`). <!-- ponytail: no dropping of generic roots; tune if skewed -->
- `centroid`: mean of ≤ 2000 randomly sampled embeddings of files tagged with the tag
  **or its descendants** (consistent with §9 matching). Cold start (no images): `v = textEmb`.
- `w_text` = `ml.tagSuggestionTextWeight` (default 0.5, `w_img = 1 − w_text`) — calibration
  knob, settable in Settings. Real-world tuning expected; 0.5 is a guess.
- Cached in `TagVector`; invalidated by `Meta.linksVersion`; recomputed lazily on next use.

### 13.5 Natural-language search (combined with tag chips)

- Token model extension (§9.1): `kind: "tag" | "text"`. A text chip is created from an
  "Semantic: '&lt;input&gt;'" fallback row in the autocomplete when no tag matches.
  **Max one text chip per query** (UI-enforced). Serializes into `?q=` and saved searches
  like any other token.
- Execution path in `search.query`:
  1. Text chip → `/embed/text` → `q`.
  2. Tag chips → §9.3 SQL → candidate id set `C` (no tag chips = unconstrained).
  3. Loop: `/knn {q, k: 2000, skip}` → filter by `C` in Node (Set lookup) → accumulate
     until the page is full or results exhaust. No tag chips: plain kNN, paginate by `skip`.
  4. Order = descending score; no keyset cursor (skip/offset within the ranked list).
- Semantics: similarity ranks, tag chips filter. `untagged` etc. keep working as filters.

### 13.6 Similar images

Context action "Find similar" on any file: pushes a `kind: "similar"` chip (carrying
the fileId) into the search bar, not a special view. The chip routes through
`similarSearch` in `search.query`: embed the seed on demand if missing (§13.2) →
`/knn {q: vector, k: 2000}` minus self → tag chips filter the ranked loop (same
`vectorSearch` core as §13.5). Renders as a normal search page (thumbnail + ↭ in the
chip), so find-similar combines freely with tag filtering. Serializes into `?q=` and
saved searches like any other token (not text-expressible in the §9.2 string form).

### 13.7 Tag suggestions (two surfaces)

- **For a tag** (Browse, §11.1): selecting a tag node shows a collapsible "Suggested"
  strip above the grid: `/knn {q: tagVector(T), k: 60, excludeTag: T}` — only untagged
  (for T and its descendants) images appear. Each tile gets a quick-accept ✓ button
  (adds exact tag `T`, bumps linksVersion, tile disappears) plus normal click → viewer.
  No rejection action in v1.
- **For an image** (Viewer, §10.2): below the tag manager, "Suggested tags": kNN of the
  image's vector against the `TagVector` matrix, top 5 with
  score ≥ `ml.tagSuggestionMinScore` (default 0.25 — calibration knob, expect to tune it).
  Click a chip → add the tag. Tags already on the file are excluded.

### 13.8 tRPC `ml` router

`status` (health + bootstrap progress + `embedded x/y` counts), `setEnabled(bool)`
(validate python → bootstrap → spawn / teardown), `similar(fileId)`,
`suggestImagesForTag(tag)`, `suggestTagsForFile(fileId)`, `reembedAll`.
`search.query` internally routes through the sidecar when a text (§13.5) or similar
(§13.6) chip is present — no separate client call.

### 13.9 Config additions (§2.2)

```yaml
ml:
  enabled: false
  port: 3777
  model: "ViT-B-16-SigLIP2"
  pretrained: "webli"
  tagSuggestionTextWeight: 0.5    # §13.4 calibration knob
  tagSuggestionMinScore: 0.25     # §13.7 calibration knob
```

## 14. Dependency additions

Keep to this list, nothing more:

| Package | Why |
|---|---|
| `yaml` | config |
| `sharp` | thumbnails, dimensions, palette pixels |
| `@tanstack/react-virtual` | 1M-scale grids |
| system `ffmpeg`/`ffprobe` | video probe + thumbs (documented, not npm) |
| `ml/` sidecar (python: torch, open_clip_torch, transformers, fastapi, uvicorn, pillow, numpy) | CLIP embeddings + kNN (§13); app-managed venv, not an npm dep |

Everything else is stdlib (`crypto`, `fs`, `path`) or already in the boilerplate.

## 15. Tests & verification

`vitest` (added as devDep), `assert`-style, no fixtures framework. Only the non-trivial
algorithms get tests:

- `search.test.ts` — token parse/serialize round-trip; SQL translation against a seeded
  in-memory SQLite: AND/OR/NOT, exact vs descendants, wildcard mid-tag, `untagged`,
  combined modifiers.
- `tags.test.ts` — rename rewrites descendants + merges collisions; merge dedupes links;
  tree counts roll up prefixes.
- `scanner.test.ts` — temp-dir fixture: new file indexed, rename keeps tags, content change
  re-hashes and moves path, vanished path pruned, file row retained, purge deletes.
- `sessions.test.ts` — generation pulls correct counts, no cross-block repeats, history
  truncation at cap.
- `palette.test.ts` — median cut returns N well-formed hex colors from a synthetic bitmap.
- `ml.test.ts` — against a stub sidecar (no real model): §13.4 combined-vector math
  (normalize/centroid/weights, cold start), §13.5 over-fetch + tag-filter loop (fake kNN
  pages + a tag-filter set), §13.7 exclusion of already-tagged files, linksVersion
  invalidation of `TagVector`.

Manual checklist for UI: browse trees, chip search, viewer nav/panels, queue reorder,
session run with timer + snooze, palette eyedropper, settings round-trip with config.yaml.

## 16. Build order (suggested)

1. §2 data dir + config service → §3 auth → §4 schema
2. §5 scanner + §6 thumbnails (testable headless)
3. §7 tags → §9 search service (+ tests)
4. §8 routers
5. §10 shared components → pages in order: Browse, Search, Queue, Viewer polish, Sessions,
   Palettes, Settings
6. §12 scheduler, §13 sidecar + semantic features (stub-testable before the model ever
   downloads), final pass on §15 checklist
