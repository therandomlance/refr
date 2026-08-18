import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      refr: path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "test/empty.ts"),
    },
  },
  test: {
    globalSetup: ["test/globalSetup.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false, // one shared sqlite, sequential = deterministic
  },
});
