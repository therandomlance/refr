import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db } from "refr/server/db";
import * as config from "./config";
import { paths } from "./dataDir";
import { listJson, readJson, safeName, writeJson } from "./jsonStore";
import { getRules } from "./tagRules";
import { makeToken, resolvePathAliases, resolveTagAliases, tokenSchema, tokensToWhere, type Token } from "./search";

/** One row of a template. `images` blocks draw `count` random files matching
 *  `tokens` (canonical search chips; legacy templates have only `tag`, read as
 *  one plain tag chip). `break` blocks are a timed rest with no image. */
export const blockSchema = z
  .object({
    kind: z.enum(["images", "break"]).default("images"),
    /** display label; for legacy blocks also the tag drawn from */
    tag: z.string().default(""),
    tokens: z.array(tokenSchema).optional(),
    count: z.number().int().min(1).default(1),
    seconds: z.number().min(1).nullable().default(null),
    autoScroll: z.boolean().default(false),
  })
  .refine(
    (b) => (b.kind === "break" ? b.seconds !== null : b.tag.trim().length > 0 || (b.tokens?.length ?? 0) > 0),
    "Image blocks need a search; breaks need a duration",
  );

export const templateSchema = z.object({
  name: z.string().min(1),
  blocks: z.array(blockSchema),
  /** don't redraw images used in the last N runs (falls back to them when the pool runs dry) */
  avoidRecent: z.number().int().min(0).default(0),
});

export type SessionBlock = z.infer<typeof blockSchema>;
export type SessionTemplate = z.infer<typeof templateSchema>;

const historyEntrySchema = z.object({
  date: z.string(),
  blocks: z.array(z.object({
    tag: z.string(),
    fileIds: z.array(z.string()),
    // recorded since break blocks; older entries look timing up in the template by tag
    kind: z.enum(["images", "break"]).optional(),
    seconds: z.number().nullable().optional(),
    autoScroll: z.boolean().optional(),
  })),
  /** set by `finish` when a run ends (stats) */
  finishedAt: z.string().optional(),
  elapsedSeconds: z.number().min(0).optional(),
  /** images reached, in run order */
  viewed: z.number().int().min(0).optional(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

const historySchema = z.array(historyEntrySchema);

function templatePath(name: string) {
  return path.join(paths.sessions, safeName(name) + ".json");
}

function historyPath(name: string) {
  return path.join(paths.sessions, safeName(name) + ".history.json");
}

export function listTemplates(): string[] {
  return listJson(paths.sessions).filter((n) => !n.endsWith(".history"));
}

export function getTemplate(name: string): SessionTemplate | null {
  return readJson(templatePath(name), templateSchema);
}

export function saveTemplate(tpl: z.input<typeof templateSchema>) {
  const validated = templateSchema.parse(tpl);
  writeJson(templatePath(validated.name), validated);
}

export function deleteTemplate(name: string) {
  fs.rmSync(templatePath(name), { force: true });
  fs.rmSync(historyPath(name), { force: true });
}

export function renameTemplate(oldName: string, newName: string) {
  const tpl = getTemplate(oldName);
  if (!tpl) throw new Error(`template '${oldName}' not found`);
  const renamed = { ...tpl, name: newName };
  saveTemplate(renamed);
  // only remove the old file when it isn't the file we just wrote (same or
  // colliding safeName) — otherwise this deletes the save
  if (templatePath(oldName) !== templatePath(newName)) {
    fs.rmSync(templatePath(oldName), { force: true });
    if (fs.existsSync(historyPath(oldName))) {
      fs.renameSync(historyPath(oldName), historyPath(newName));
    }
  }
}

export function getHistory(name: string): HistoryEntry[] {
  return readJson(historyPath(name), historySchema) ?? [];
}

function appendHistory(name: string, entry: HistoryEntry) {
  const cap = config.get().sessionHistoryCap;
  const history = [entry, ...getHistory(name)].slice(0, cap);
  writeJson(historyPath(name), history);
}

/** The block's search as executable tag tokens (vector chips don't apply to sessions). */
function blockTokens(block: SessionBlock): Token[] {
  const tokens = block.tokens?.length ? block.tokens : [makeToken({ tag: block.tag.trim() })];
  return resolveTagAliases(resolvePathAliases(tokens, config.libraryAliases()), getRules())
    .filter((t) => t.kind === "tag" && !t.tag.startsWith("suggest:"));
}

async function draw(tokens: Token[], count: number, exclude: Set<string>): Promise<string[]> {
  if (count <= 0) return [];
  const where = tokensToWhere(tokens); // includes the hidden-duplicate filter
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT f.id FROM File f
     WHERE (${where.text}) AND f.id NOT IN (SELECT value FROM json_each(?))
     ORDER BY RANDOM() LIMIT ?`,
    ...where.params, JSON.stringify([...exclude]), count,
  );
  return rows.map((r) => r.id);
}

/**
 * Generate a run: per block, draw distinct random files matching its search,
 * excluding files drawn earlier in the same session and (with `avoidRecent`)
 * files from the last N runs, unless that leaves the block short. Appends history.
 */
export async function generate(name: string): Promise<HistoryEntry> {
  const tpl = getTemplate(name);
  if (!tpl) throw new Error(`template '${name}' not found`);
  const recent = new Set(
    getHistory(name).slice(0, tpl.avoidRecent).flatMap((e) => e.blocks.flatMap((b) => b.fileIds)),
  );
  const drawn = new Set<string>();
  const blocks: HistoryEntry["blocks"] = [];
  for (const block of tpl.blocks) {
    if (block.kind === "break") {
      blocks.push({ tag: block.tag.trim() || "Break", fileIds: [], kind: "break", seconds: block.seconds, autoScroll: true });
      continue;
    }
    const tokens = blockTokens(block);
    const picked = await draw(tokens, block.count, new Set([...drawn, ...recent]));
    if (picked.length < block.count && recent.size) {
      picked.push(...(await draw(tokens, block.count - picked.length, new Set([...drawn, ...picked]))));
    }
    for (const id of picked) drawn.add(id);
    blocks.push({ tag: block.tag, fileIds: picked, kind: "images", seconds: block.seconds, autoScroll: block.autoScroll });
  }
  const entry: HistoryEntry = { date: new Date().toISOString(), blocks };
  appendHistory(name, entry);
  return entry;
}

/** Record how a run ended (from the summary screen). Matches the entry by its
 *  `date`; a replayed run updates the original entry. */
export function finish(name: string, date: string, stats: { elapsedSeconds: number; viewed: number }) {
  const history = getHistory(name);
  const entry = history.find((e) => e.date === date);
  if (!entry) return;
  entry.finishedAt = new Date().toISOString();
  entry.elapsedSeconds = Math.round((entry.elapsedSeconds ?? 0) + stats.elapsedSeconds);
  entry.viewed = Math.max(entry.viewed ?? 0, stats.viewed);
  writeJson(historyPath(name), history);
}

export type SessionStats = {
  days: { date: string; seconds: number; images: number; sessions: number }[];
  tags: { tag: string; images: number }[];
  totals: { sessions: number; seconds: number; images: number };
};

const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Practice totals across every template's history (finished runs only). */
export function stats(): SessionStats {
  const days = new Map<string, SessionStats["days"][number]>();
  const tags = new Map<string, number>();
  const totals = { sessions: 0, seconds: 0, images: 0 };
  for (const name of listTemplates()) {
    for (const e of getHistory(name)) {
      if (!e.finishedAt) continue;
      const day = localDay(e.finishedAt);
      const row = days.get(day) ?? { date: day, seconds: 0, images: 0, sessions: 0 };
      const seconds = e.elapsedSeconds ?? 0;
      const viewed = e.viewed ?? 0;
      row.seconds += seconds;
      row.images += viewed;
      row.sessions += 1;
      days.set(day, row);
      totals.sessions += 1;
      totals.seconds += seconds;
      totals.images += viewed;
      // attribute the images reached to their blocks, in run order
      let left = viewed;
      for (const b of e.blocks) {
        if (left <= 0) break;
        if (b.kind === "break") continue;
        const n = Math.min(left, b.fileIds.length);
        left -= n;
        if (n) tags.set(b.tag, (tags.get(b.tag) ?? 0) + n);
      }
    }
  }
  return {
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    tags: [...tags].map(([tag, images]) => ({ tag, images })).sort((a, b) => b.images - a.images).slice(0, 10),
    totals,
  };
}

export function replay(name: string, historyIndex: number): HistoryEntry {
  const entry = getHistory(name)[historyIndex];
  if (!entry) throw new Error(`history entry ${historyIndex} not found`);
  return entry;
}
