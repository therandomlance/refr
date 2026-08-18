import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TEST_DATA = "/tmp/refr-vitest-data";

/** Fresh temp data dir + pushed schema, shared by all test workers. */
export default function setup() {
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA, { recursive: true });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: `file:${path.join(TEST_DATA, "refr.db")}` },
    stdio: "inherit",
  });
}
