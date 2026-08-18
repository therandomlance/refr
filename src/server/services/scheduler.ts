import "server-only";
import { configEvents, get } from "./config";
import { scanNow } from "./scanner";

let timer: NodeJS.Timeout | null = null;

function msUntilNext(time: string): number {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h ?? 0, m ?? 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function arm() {
  if (timer) clearTimeout(timer);
  timer = null;
  const scanTime = get().scanTime;
  if (!scanTime) return;
  timer = setTimeout(() => {
    void scanNow().finally(arm);
  }, msUntilNext(scanTime));
  timer.unref?.();
}

export function startScheduler() {
  arm();
  configEvents.on("change", arm);
}
