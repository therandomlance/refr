import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "./dataDir";
import { readJson, safeName, writeJson } from "./jsonStore";
import { tokenSchema, type Token, type Sort } from "./search";

const savedSchema = z.object({
  name: z.string().min(1),
  tokens: z.array(tokenSchema),
  sort: z.enum(["date", "name", "size", "random", "similarity"]).optional(),
});

export type SavedSearch = z.infer<typeof savedSchema>;

function fileFor(name: string) {
  return path.join(paths.searches, safeName(name) + ".json");
}

export function list(): SavedSearch[] {
  if (!fs.existsSync(paths.searches)) return [];
  return fs
    .readdirSync(paths.searches)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(paths.searches, f), savedSchema))
    .filter((s): s is SavedSearch => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function save(name: string, tokens: Token[], sort?: Sort) {
  const entry = savedSchema.parse({ name, tokens, ...(sort ? { sort } : {}) });
  writeJson(fileFor(name), entry);
}

export function remove(name: string) {
  fs.rmSync(fileFor(name), { force: true });
}

export function rename(oldName: string, newName: string) {
  const existing = readJson(fileFor(oldName), savedSchema);
  if (!existing) throw new Error(`search '${oldName}' not found`);
  save(newName, existing.tokens, existing.sort);
  fs.rmSync(fileFor(oldName), { force: true });
}
