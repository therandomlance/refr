import "server-only";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import YAML from "yaml";
import { THEMES, ACCENTS, DENSITIES, LEGACY_THEME_MAP } from "refr/lib/themes";
import { normalize } from "refr/lib/tag-names";
import { resolveAliasedPath } from "refr/lib/timeline";
import { initDataDir, paths } from "./dataDir";

export { THEMES, ACCENTS, DENSITIES };

/** A read-only library root. `alias` names it for `path:<alias>` searching. */
export const librarySchema = z.object({
  path: z.string(),
  alias: z.string().optional(),
});
export type Library = z.infer<typeof librarySchema>;

// Keep existing string-only configs working while destinations gain aliases.
export const sendToPathsSchema = z
  .array(z.union([
    z.string().trim().min(1),
    z.object({ path: z.string().trim().min(1), alias: z.string().trim().transform((s) => s || undefined).optional() }),
  ]))
  .transform((dests) => dests.map((d) => typeof d === "string" ? { path: d, alias: undefined } : d));

const configObject = z.object({
  passwordHash: z.string().nullable().default(null),
  // Accepts legacy `libraries: ["/path"]` and normalizes to objects.
  libraries: z
    .array(z.union([z.string(), librarySchema]))
    .default([])
    .transform((libs) =>
      libs.map((l) =>
        typeof l === "string"
          ? { path: l }
          : { path: l.path, alias: l.alias },
      ),
    ),
  scanTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .default("03:00"),
  defaultThumbnailSize: z.enum(["small", "medium", "large"]).default("medium"),
  skipTagRemoveConfirm: z.boolean().default(false),
  sendToPaths: sendToPathsSchema.default([]),
  /** Kept out of the unfiltered main timeline (still indexed and searchable).
   *  `paths`: absolute folders, or `<alias>` / `<alias>/<sub>` of a library.
   *  `tags`: files carrying one of these (or a tag beneath it). */
  timelineExclude: z
    .object({
      paths: z.array(z.string()).default([]).transform((ps) => [
        ...new Set(ps.map((p) => p.trim()).map((p) => (p.length > 1 ? p.replace(/\/+$/, "") : p)).filter(Boolean)),
      ]),
      tags: z.array(z.string()).default([]).transform((ts) => [...new Set(ts.map(normalize).filter(Boolean))].sort()),
    })
    .default({}),
  sessionHistoryCap: z.number().int().min(1).default(1000),
  theme: z.enum(THEMES).default("obsidian"),
  accent: z.enum(ACCENTS).default("blue"),
  density: z.enum(DENSITIES).default("comfortable"),
  /** refr.db snapshot after each nightly scan, keeping the newest `keep` */
  backup: z
    .object({
      enabled: z.boolean().default(true),
      keep: z.number().int().min(1).max(100).default(7),
    })
    .default({}),
  ml: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().default(3777),
      model: z.string().default("ViT-B-16-SigLIP2"),
      pretrained: z.string().default("webli"),
      tagSuggestionTextWeight: z.number().min(0).max(1).default(0.5),
      /** "auto": per-tag classifiers (TagClassifier) for tags with enough images,
       *  tag vector otherwise; "vector": tag vector only. */
      tagModel: z.enum(["auto", "vector"]).default("auto"),
    })
    .default({}),
});

/** Map pre-overhaul theme ids to the new theme (+ its accent when none is set). */
function migrateTheme(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const legacy = typeof obj.theme === "string" && !(THEMES as readonly string[]).includes(obj.theme)
    ? LEGACY_THEME_MAP[obj.theme]
    : undefined;
  if (!legacy) return raw;
  return { ...obj, theme: legacy.theme, accent: obj.accent ?? legacy.accent };
}

/** The experimental `ml.tagClassifier` boolean became `ml.tagModel`. Classifiers
 *  are now the default, so a stored `false` (the old default) also maps to "auto". */
function migrateMl(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const ml = obj.ml;
  if (typeof ml !== "object" || ml === null || Array.isArray(ml) || !("tagClassifier" in ml)) return raw;
  const rest = { ...(ml as Record<string, unknown>) };
  delete rest.tagClassifier;
  return { ...obj, ml: { tagModel: "auto", ...rest } };
}

/** Libraries used to carry `timeline: false`; those become `timelineExclude.paths`
 *  entries (by alias when they have one, so the entry follows a moved library). */
function migrateTimeline(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.libraries)) return raw;
  const libraries = obj.libraries as unknown[];
  const hidden = libraries.filter(
    (l): l is { path: string; alias?: string } =>
      typeof l === "object" && l !== null && (l as { timeline?: unknown }).timeline === false && typeof (l as { path?: unknown }).path === "string",
  );
  if (hidden.length === 0) return raw;
  const prev = (typeof obj.timelineExclude === "object" && obj.timelineExclude !== null ? obj.timelineExclude : {}) as Record<string, unknown>;
  const prevPaths = Array.isArray(prev.paths) ? (prev.paths as unknown[]) : [];
  return {
    ...obj,
    libraries: libraries.map((l) => {
      if (typeof l !== "object" || l === null) return l;
      const rest = { ...(l as Record<string, unknown>) };
      delete rest.timeline;
      return rest;
    }),
    timelineExclude: { ...prev, paths: [...prevPaths, ...hidden.map((l) => (l.alias?.trim() ? l.alias.trim() : l.path))] },
  };
}

const configSchema = z.preprocess((raw) => migrateTimeline(migrateMl(migrateTheme(raw))), configObject);

export type Config = z.infer<typeof configSchema>;

const DEFAULTS = configSchema.parse({});

let cache: Config | null = null;
let cacheMtime = 0;
let watcher: fs.FSWatcher | null = null;
let debounce: NodeJS.Timeout | null = null;

/** Emits "change" when config changes externally (used to re-arm the scheduler). */
export const configEvents = new EventEmitter();

function readFile(): Config {
  initDataDir();
  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(paths.config, YAML.stringify(DEFAULTS));
    return DEFAULTS;
  }
  const raw = fs.readFileSync(paths.config, "utf8");
  const parsed: unknown = raw.trim() ? YAML.parse(raw) : {};
  return configSchema.parse(parsed ?? {});
}

export function get(): Config {
  // Next dev/prod creates multiple module instances (RSC, route handlers,
  // instrumentation) — re-read when the file changed on disk. statSync is
  // ~µs; the YAML parse only happens on actual change.
  if (cache) {
    const mtime = fs.existsSync(paths.config) ? fs.statSync(paths.config).mtimeMs : 0;
    if (mtime === cacheMtime) return cache;
  }
  cache = readFile();
  cacheMtime = fs.existsSync(paths.config) ? fs.statSync(paths.config).mtimeMs : 0;
  return cache;
}

/** Resolved library roots (in config order). */
/** Library aliases → resolved root, lowercased keys: `path:<alias>` lookup. */
export function libraryAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of get().libraries) {
    if (l.alias) out[l.alias.toLowerCase()] = path.resolve(l.path);
  }
  return out;
}

export function libraryRoots(): string[] {
  return get().libraries.map((l) => path.resolve(l.path));
}

/** Excluded timeline folders as real paths. Alias entries whose library is gone
 *  (or relative paths that name no alias) are skipped. */
export function timelineExcludedPaths(): string[] {
  const aliases = libraryAliases();
  return get().timelineExclude.paths.flatMap((p) => {
    if (p.startsWith("/")) return [path.resolve(p)];
    const resolved = resolveAliasedPath(p, aliases);
    return resolved === null ? [] : [resolved];
  });
}

/** Follow a tag rename/merge in `timelineExclude.tags`. */
export function rewriteTimelineExcludedTags(map: (name: string) => string) {
  const { tags } = get().timelineExclude;
  const next = tags.map(map);
  if (next.some((t, i) => t !== tags[i])) patch({ timelineExclude: { tags: next } });
}

function write(cfg: Config) {
  const tmp = paths.config + ".tmp";
  fs.writeFileSync(tmp, YAML.stringify(cfg));
  fs.renameSync(tmp, paths.config);
  cacheMtime = fs.statSync(paths.config).mtimeMs;
}

/** Deep-merge partial, validate, write atomically, update cache. */
export function patch(partial: unknown): Config {
  const current = get();
  const merged = deepMerge(current, partial);
  const next = configSchema.parse(merged);
  write(next);
  cache = next;
  configEvents.emit("change", next);
  return next;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base) &&
    typeof over === "object" &&
    over !== null &&
    !Array.isArray(over)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return over;
}

/** Watch config.yaml for external edits so the UI reflects them. */
export function watch() {
  if (watcher) return;
  initDataDir();
  if (!fs.existsSync(paths.config)) get(); // create it
  // Watch the directory, not the file: write() replaces config.yaml via
  // rename, and a file watch follows the old inode (it goes silent after the
  // first save).
  const base = path.basename(paths.config);
  watcher = fs.watch(path.dirname(paths.config), (_event, filename) => {
    if (filename !== null && filename.toString() !== base) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const next = readFile();
        const changed = JSON.stringify(next) !== JSON.stringify(cache);
        cache = next;
        if (changed) configEvents.emit("change", next);
      } catch {
        // file mid-write or invalid — keep old cache
      }
    }, 500);
  });
}
