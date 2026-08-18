import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db } from "refr/server/db";
import * as config from "./config";
import { paths } from "./dataDir";
import { listJson, readJson, safeName, writeJson } from "./jsonStore";
import { normalize } from "./tags";

export const blockSchema = z.object({
  tag: z.string().min(1),
  count: z.number().int().min(1),
  seconds: z.number().min(1).nullable().default(null),
  autoScroll: z.boolean().default(false),
});

export const templateSchema = z.object({
  name: z.string().min(1),
  blocks: z.array(blockSchema),
});

export type SessionBlock = z.infer<typeof blockSchema>;
export type SessionTemplate = z.infer<typeof templateSchema>;

const historyEntrySchema = z.object({
  date: z.string(),
  blocks: z.array(z.object({ tag: z.string(), fileIds: z.array(z.string()) })),
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

export function saveTemplate(tpl: SessionTemplate) {
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
  fs.rmSync(templatePath(oldName), { force: true });
  if (fs.existsSync(historyPath(oldName))) {
    fs.renameSync(historyPath(oldName), historyPath(newName));
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

/**
 * Generate a run: per block, resolve tag+descendants → distinct random ids,
 * excluding ids drawn earlier in the same session. Appends history.
 */
export async function generate(name: string): Promise<HistoryEntry> {
  const tpl = getTemplate(name);
  if (!tpl) throw new Error(`template '${name}' not found`);
  const drawn = new Set<string>();
  const blocks: HistoryEntry["blocks"] = [];
  for (const block of tpl.blocks) {
    const tag = normalize(block.tag);
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT DISTINCT f.id FROM File f
       JOIN FileTag ft ON ft.fileId = f.id
       JOIN Tag t ON t.id = ft.tagId
       WHERE (t.name = ? OR t.name LIKE ? ESCAPE '\\')
       ORDER BY RANDOM() LIMIT ?`,
      tag,
      `${tag.replace(/[\\%_]/g, (c) => "\\" + c)}/%`,
      block.count + drawn.size,
    );
    const picked: string[] = [];
    for (const r of rows) {
      if (drawn.has(r.id)) continue;
      drawn.add(r.id);
      picked.push(r.id);
      if (picked.length >= block.count) break;
    }
    blocks.push({ tag: block.tag, fileIds: picked });
  }
  const entry: HistoryEntry = { date: new Date().toISOString(), blocks };
  appendHistory(name, entry);
  return entry;
}

export function replay(name: string, historyIndex: number): HistoryEntry {
  const entry = getHistory(name)[historyIndex];
  if (!entry) throw new Error(`history entry ${historyIndex} not found`);
  return entry;
}
