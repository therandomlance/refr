A new self-hosted application to manage and view a user's collection of images with a focus on usability as a platform to search for and view reference images while drawing or painting.

The application should feature a smooth, modern, minimal UI usable on desktop and tablet primarily, and phone secondarily (responsive and functional; no phone-specific features).

The primary references for the functionality of this app are [Immich](https://github.com/immich-app/immich) and [Hydrus Network](https://github.com/hydrusnetwork/hydrus). These programs may be referenced to describe a feature, but their whole code base does not need to be understood.

## Tech Stack

T3 stack, boilerplate already initialized: Next.js, TypeScript, tRPC, Prisma (SQLite), Tailwind.

Auth: simpler than NextAuth. Single user. One password set in the config file (stored hashed), a login page, and a signed session cookie. No user accounts or registration. If no password is set, the app is open (trusted network).

## Data Model

**SQLite** (via Prisma) holds everything needed for search:
- Files: id = content hash (sha256), all known paths, size, mtime, dimensions, duration (video), media type, date added.
- Tags and file↔tag links.

**Plaintext** in the data directory holds all user data:
```
data/
  config.yaml      # all settings, incl. libraries
  refr.db
  thumbnails/      # <file-id>.webp
  queues/          # saved queues, one JSON file each
  sessions/        # session templates + one history file per template (JSON)
  palettes/        # one JSON per palette; subfolders = palette folders
```

Configurable location for the data directory (env var / CLI flag). Sane defaults.

**Scale:** current library ~100k images, plan for up to 1M. Consequences: paginate/virtualize all lists, index hash and tag columns, scan and thumbnail generation run as background jobs, never load unbounded result sets into memory.

## Functionality

### Files

refr itself does not upload, store, or manage any files of its own. Instead, it uses a system similar to Immich's [external libraries](https://docs.immich.app/features/libraries): the user declares library paths, which are scanned and stored in the app's database.

- **Libraries are read-only.** The app never writes to, moves, or deletes library files. (The only write-outside-data-dir action is Send-to, below.)
- **Identity = content hash.** Each file's id is its sha256. All known paths for a hash are stored, so renames/moves don't orphan tags, and duplicate content at multiple paths maps to one file.
- **Scanning:** nightly at a user-configured time (HH:MM), or disabled. Also a manual "Scan now" button in Settings. A scan checks known paths, hashes new/changed files, adds new paths for known hashes, and prunes vanished paths. Files whose paths have all vanished keep their DB row (tags preserved if the file returns, e.g. unmounted drive); a purge option lives in Settings.
- **Formats:** all common image and video formats. Focus is on images.
- **Thumbnails:** kept. Generated as a background job during scan, stored as webp (~512px long edge) at `thumbnails/<id>.webp`. Video thumbnails are an extracted frame via ffmpeg (dependency). The fullscreen viewer loads the original file; grids use thumbnails.

### Tags

Hierarchical tags with `/` as the separator (e.g. `reference/figure/arms`), stored app-side in SQLite — library files are never modified. Tags are the primary way to search for files.

Examples:
- `artwork/fanart/mass effect/liara`
- `reference/architecture`
- `reference/figure/arms`

Searching a parent tag returns all descendants by default (see Search for the exact-match syntax).

### Database

SQLite via Prisma, lives at `<data>/refr.db`. See Data Model for the SQLite-vs-plaintext split.

# Web app

Multi-page browser app (Next.js routes). The left edge of the screen shows icons for each major area. A sidebar on the left usually serves as the main point of interaction for each tab, unless otherwise noted.

Where possible, thumbnail layout, sorting, selection, and context action code/functionality should be shared between pages.
- Thumbnail size
- Waterfall layout
	- Horizontal or Vertical
- Sorting: date (default), name, size, random
- Grouping: by day (default, like Immich), month, or year — based on file date
- Fullscreen image viewer (video files use an HTML5 player). Nothing out of the ordinary
	- Left - collapsible file options/metadata
	- Right - collapsible tag manager.
		- Fuzzy tag autocomplete for adding tags
		- quickly remove tags with [X] button
			- User option to skip confirmation
	- arrow key navigation
	- Bottom - Previous/next image carousel, collapsible
- Context actions
	- Create color palette with image
	- Send to
		- User-configurable path(s) to send a copy of the image file to. Useful for sending to an Obsidian vault or other working folder. Send-to may write to the directories the user supplies. Filename collision → append a suffix (`name (1).jpg`).
	- Tag actions

## Browse - folder icon

Choose to browse either with folders or tags.

A sidebar showing a tree view and a main thumbnail grid. I like how it's done in Immich, reference that design.

- Folder tree's top level is each library; tag tree's top level is top-level tags. Tree nodes are expandable in the sidebar, like a normal file browser.
- At root, the grid shows only top-level paths (or top-level tags) as cards — no images.
- Selecting a node loads its images into the grid — for tags **including all descendants** (consistent with Search); for folders only the files directly in that folder. Child folders/subtags render as cards at the top of the grid; double-click a card to descend.
- The tag tree shows only tags with ≥1 file, with a count badge.
- Folder browsing is read-only (outside the shared context actions). Tag tree supports management actions: rename, merge, delete — these are global (they rewrite the tag everywhere it appears, with confirmation).

**Future scope:** Suggested images for a tag, based on similarity to other tagged images or other CLIP tech. Currently do not know how to implement.

## Search - search icon

Search for images based on tags using a typed query following common booru conventions (starting point, to be refined):

- Terms are ANDed: `reference/figure arms`
- `-term` is NOT: `figure -arms`
- `~a ~b` is OR: `~reference/figure ~artwork/fanart`
- A tag matches itself **and all descendants** by default. Prefix with `=` for exact match (no children): `=reference/figure`
- `*` is a wildcard matching any sequence of characters in the full tag path: `artwork/fanart/*`, `*/liara`, `mass*`. Wildcard terms match the pattern exactly — no implicit descendant expansion (`reference/*` already covers descendants).
- Modifiers can be combined: `-=reference/figure` excludes exactly that tag (children still allowed), `~=` ORs exact matches, modifiers apply to wildcards too (`-*nsfw*`). Order: `-`/`~` first, then `=`.
- Metadata keywords such as `untagged`; the keyword set is extensible.

**Query input is token-based, not free text.** Each term is a discrete chip/object (`{ tag, modifier }`), so tags containing spaces (e.g. `artwork/fanart/mass effect/liara`) are unambiguous — chips delimit terms, spaces don't.

- Typing in the input shows fuzzy tag autocomplete; Enter commits the highlighted suggestion as a chip.
- Prefixing with `-`, `~`, or `=` (or a combination, e.g. `-=`) while typing attaches those modifiers to the chip; modifiers are displayed on the chip.
- Chips are removable via backspace or an [X] on the chip.
- The chip list serializes to/from the string syntax above, so queries remain shareable via URL.

## Queue

Short-term queue to mark images I want to come back to for study. One active queue at a time — keep it simple.
- Be able to re-order, easily add and remove images from queue anywhere.
- Clear queue button (with confirmation).
- Save queue to a plaintext JSON file in `data/queues/`
- show saved queues
- reload queue

## Sessions

Randomized "queues" based on tags. Meant to be a random study session for art practice.
- Configurable sessions using a defined file format, each session template stored as plaintext JSON in `data/sessions/`.
- Sessions are named.
- Core functionality: ordered list of tags defining what and how many images to pull from. Tags only (no metadata filters). Each row contains:
	- tag
	- number of images
	- time per image (optional)
	- Auto-scroll: true or false (only active if a time is set)
		- Whether the image automatically moves to the next one when time is up. Otherwise an indicator flashes
		- snoozable by +30s, +1m, +5m, +10m — snooze **adds** time to the current image
- Session templates can be written in the app and saved.
	- UI could be something like this. Make sure it looks good
		- `:: [    tag    ] | [  num  ] | [  time  ], [ ]: Auto-Scroll | [X]`
		- `[ + Add new ]`
	- Reorder rows as needed
- The images used in each session are stored in a single history file per template (JSON, truncated to the newest N entries, default 1000, configurable). Each entry can be selected from the web app and reloaded as a fresh live session to be re-done.
- Different blocks in the same session do not necessarily all have to be timed or un-timed
- Actual session viewing uses the regular image viewer; a timer is visible if a time is set.
- Session end shows a summary screen.

## Color Palettes

Main reference: [colorhunt](https://colorhunt.co/)

View, save, organize color palettes similar to colorhunt.
- Palettes can be exported as a striped square/rectangle PNG, and colors can be copied as hex values.
- Allow for custom number of colors per palette, up to 10.
- Default 4.
- Each can be named, stored, sorted into folders.
	- Each palette is one JSON file; folder structure mirrors the folders in `data/palettes/`

For any image, a context menu action to generate a color palette from it. Automatically detect the palette colors, and allow overriding individual swatches with an eyedropper that selects from the image.

**Future Scope:** Color selector including color wheel theory references.

## Settings

Separate tab for settings. Everything is settable both in the settings UI and in `data/config.yaml`; the two reflect each other (editing one updates the other).

Settings include:
- Libraries (paths to scan)
- Nightly scan time (HH:MM or off) + "Scan now" button
- Purge files with no existing paths
- Password (set/change/clear)
- Default thumbnail size in grids
- Skip confirmation when removing tags
- Send-to destination paths
- Session history cap (default 1000)
