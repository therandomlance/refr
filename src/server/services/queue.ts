import "server-only";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { paths } from "./dataDir";
import { listJson, readJson, safeName, writeJson } from "./jsonStore";

const queueSchema = z.object({ fileIds: z.array(z.string()) });

const ACTIVE = path.join(paths.queues, "active.json");

export function getQueue(): string[] {
  return readJson(ACTIVE, queueSchema)?.fileIds ?? [];
}

export function setQueue(fileIds: string[]) {
  writeJson(ACTIVE, { fileIds: [...new Set(fileIds)] });
}

export function clearQueue() {
  fs.rmSync(ACTIVE, { force: true });
}

export function saveQueue(name: string) {
  const ids = getQueue();
  writeJson(path.join(paths.queues, safeName(name) + ".json"), { fileIds: ids });
}

export function listSaved(): string[] {
  return listJson(paths.queues).filter((n) => n !== "active");
}

export function loadQueue(name: string): string[] {
  const data = readJson(path.join(paths.queues, safeName(name) + ".json"), queueSchema);
  if (!data) throw new Error(`queue '${name}' not found`);
  writeJson(ACTIVE, data);
  return data.fileIds;
}

export function deleteSaved(name: string) {
  fs.rmSync(path.join(paths.queues, safeName(name) + ".json"), { force: true });
}
