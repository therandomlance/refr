import "server-only";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/**
 * Resolves and initializes the data directory.
 * CLI flag `--data <dir>` > env DATA_DIR > ./data
 */
function resolve(): string {
  const idx = process.argv.indexOf("--data");
  const fromArg = idx >= 0 ? process.argv[idx + 1] : undefined;
  const dir = fromArg ?? process.env.DATA_DIR ?? "./data";
  return path.resolve(dir);
}

export const DATA_DIR = resolve();

export const paths = {
  root: DATA_DIR,
  config: path.join(DATA_DIR, "config.yaml"),
  db: path.join(DATA_DIR, "refr.db"),
  secret: path.join(DATA_DIR, ".secret"),
  thumbnails: path.join(DATA_DIR, "thumbnails"),
  queues: path.join(DATA_DIR, "queues"),
  sessions: path.join(DATA_DIR, "sessions"),
  searches: path.join(DATA_DIR, "searches"),
  palettes: path.join(DATA_DIR, "palettes"),
  mlVenv: path.join(DATA_DIR, "ml-venv"),
};

export function getSecret(): string {
  return fs.readFileSync(paths.secret, "utf8").trim();
}

let booted = false;

/** mkdir -p all subdirs, create .secret on first boot. Idempotent. */
export function initDataDir() {
  if (booted) return;
  booted = true;
  for (const dir of [
    paths.root,
    paths.thumbnails,
    paths.queues,
    paths.sessions,
    paths.searches,
    paths.palettes,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(paths.secret)) {
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(paths.secret, secret, { mode: 0o600 });
  }
}
