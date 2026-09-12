import "server-only";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import YAML from "yaml";
import { THEMES } from "refr/lib/themes";
import { initDataDir, paths } from "./dataDir";

export { THEMES };

/** A read-only library root. `alias` names it for `path:<alias>` searching;
 *  `timeline` toggles whether it feeds the timeline scrubber. */
export const librarySchema = z.object({
  path: z.string(),
  alias: z.string().optional(),
  timeline: z.boolean().default(true),
});
export type Library = z.infer<typeof librarySchema>;

const configSchema = z.object({
  passwordHash: z.string().nullable().default(null),
  // Accepts legacy `libraries: ["/path"]` and normalizes to objects.
  libraries: z
    .array(z.union([z.string(), librarySchema]))
    .default([])
    .transform((libs) =>
      libs.map((l) =>
        typeof l === "string"
          ? { path: l, timeline: true }
          : { path: l.path, alias: l.alias, timeline: l.timeline },
      ),
    ),
  scanTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .default("03:00"),
  defaultThumbnailSize: z.enum(["small", "medium", "large"]).default("medium"),
  skipTagRemoveConfirm: z.boolean().default(false),
  sendToPaths: z.array(z.string()).default([]),
  sessionHistoryCap: z.number().int().min(1).default(1000),
  theme: z.enum(THEMES).default("slate"),
  ml: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().default(3777),
      model: z.string().default("ViT-B-16-SigLIP2"),
      pretrained: z.string().default("webli"),
      tagSuggestionTextWeight: z.number().min(0).max(1).default(0.5),
    })
    .default({}),
});

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
export function libraryRoots(): string[] {
  return get().libraries.map((l) => path.resolve(l.path));
}

/** Roots feeding the timeline scrubber. `undefined` = no libraries configured
 *  (unconstrained), `[]` = libraries configured but all excluded. */
export function timelineRoots(): string[] | undefined {
  const libs = get().libraries;
  if (libs.length === 0) return undefined;
  return libs.filter((l) => l.timeline !== false).map((l) => path.resolve(l.path));
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
  watcher = fs.watch(paths.config, () => {
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
