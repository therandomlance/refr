import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";

/** Tiny helpers for the plaintext-JSON services. Names become safe filenames. */

export function safeName(name: string): string {
  const n = name.trim().replace(/[/\\:*?"<>|]/g, "_").replace(/^\.+/, "");
  if (!n) throw new Error("invalid name");
  return n;
}

export function readJson<S extends z.ZodTypeAny>(file: string, schema: S): z.infer<S> | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  return schema.parse(JSON.parse(raw)) as z.infer<S>;
}

export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function listJson(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}
