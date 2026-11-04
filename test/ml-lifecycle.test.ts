import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import * as config from "refr/server/services/config";

const state = vi.hoisted(() => ({ children: [] as ChildProcess[], alive: false, fail: false, healthGate: null as Promise<void> | null }));
vi.mock("node:child_process", async (original) => {
  const { EventEmitter } = await import("node:events");
  return { ...await original<typeof import("node:child_process")>(), spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null,
      kill: vi.fn(() => {
        state.alive = false;
        child.exitCode = 0;
        child.emit("exit", 0);
        return true;
      }),
    });
    state.children.push(child as unknown as ChildProcess);
    queueMicrotask(() => {
      if (state.fail) child.emit("error", new Error("spawn failed"));
      else { state.alive = true; child.emit("spawn"); }
    });
    return child;
  } };
});
vi.mock("refr/server/services/thumbs", () => ({ thumbStatus: () => ({ running: true }), hasThumb: () => false, thumbPath: () => "unused" }));

it("shares sidecar ownership, startup, errors and cleanup across module graphs", async () => {
  const previous = config.get().ml;
  const exists = fs.existsSync;
  const disk = vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file).endsWith("ml/.venv/bin/python") || exists(file));
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/health")) {
      await state.healthGate;
      if (!state.alive) throw new Error("offline");
      const ml = config.get().ml;
      return Response.json({ status: "ready", model: `${ml.model}__${ml.pretrained}` });
    }
    return Response.json({ vectors: [] });
  });
  const first = await import("refr/server/services/ml");
  const listeners = process.listenerCount("exit");
  vi.resetModules();
  const other = await import("refr/server/services/ml");
  try {
    expect(process.listenerCount("exit")).toBe(listeners);
    await Promise.all([first.setEnabled(true), other.setEnabled(true)]);
    await expect.poll(async () => (await other.status()).state).toBe("ready");
    expect(state.children).toHaveLength(1);
    expect((await other.status()).log).toContain("sidecar ready");
    await other.setEnabled(false);
    expect(state.children[0]!.kill).toHaveBeenCalledOnce();
    expect((await first.status()).state).toBe("disabled");

    let release!: () => void;
    state.healthGate = new Promise<void>((resolve) => { release = resolve; });
    const enabling = first.setEnabled(true);
    await other.setEnabled(false);
    release();
    await enabling;
    state.healthGate = null;
    expect(state.children).toHaveLength(1); // cancelled bootstrap must not spawn later

    state.healthGate = new Promise<void>((resolve) => { release = resolve; });
    const cancelled = first.setEnabled(true);
    await other.setEnabled(false);
    const restarted = other.setEnabled(true);
    release();
    await Promise.all([cancelled, restarted]);
    state.healthGate = null;
    await expect.poll(async () => (await first.status()).state).toBe("ready");
    expect(state.children).toHaveLength(2);
    await other.setEnabled(false);

    state.fail = true;
    await first.setEnabled(true);
    await expect.poll(async () => (await other.status()).state).toBe("error");
    expect((await other.status()).error).toBe("spawn failed");
  } finally {
    await other.setEnabled(false);
    config.patch({ ml: previous });
    disk.mockRestore();
    vi.unstubAllGlobals();
  }
});
