import { expect, it, vi } from "vitest";

vi.mock("refr/app/_components/viewer", () => ({ Viewer: () => null }));
import { sessionReducer } from "refr/app/_components/session-runner";

const initial = { index: 0, done: false, remaining: 1, flash: false };

it("advances timed images exactly once and resets a one-image replay", () => {
  const items = [{ seconds: 1, autoScroll: true }, { seconds: 5, autoScroll: true }];
  const next = sessionReducer(initial, { type: "tick" }, items);
  expect(next).toEqual({ index: 1, done: false, remaining: 5, flash: false });
  expect(sessionReducer(next, { type: "tick" }, items).remaining).toBe(4);
  const done = sessionReducer(initial, { type: "tick" }, items.slice(0, 1));
  expect(done.done).toBe(true);
  expect(sessionReducer(done, { type: "replay" }, items.slice(0, 1))).toEqual(initial);
});

it("clamps manual expiry, rearms snooze, and resets navigation including untimed images", () => {
  const items = [{ seconds: 1, autoScroll: false }, { seconds: null, autoScroll: false }];
  const expired = sessionReducer(initial, { type: "tick" }, items);
  expect(expired).toEqual({ ...initial, remaining: 0, flash: true });
  expect(sessionReducer(expired, { type: "tick" }, items)).toBe(expired);
  const snoozed = sessionReducer(expired, { type: "snooze", seconds: 30 }, items);
  expect(snoozed).toEqual({ ...initial, remaining: 30 });
  expect(sessionReducer({ ...snoozed, remaining: 1 }, { type: "tick" }, items)).toEqual(expired);
  const untimed = sessionReducer(expired, { type: "next" }, items);
  expect(untimed.remaining).toBeNull();
  expect(sessionReducer(untimed, { type: "tick" }, items)).toBe(untimed);
  expect(sessionReducer(untimed, { type: "navigate", index: 0 }, items)).toEqual(initial);
  expect(sessionReducer(untimed, { type: "finish" }, items).done).toBe(true);
});

it("pauses the timer, keeps the pause across navigation, and replay resumes", () => {
  const items = [{ seconds: 3, autoScroll: true }, { seconds: 5, autoScroll: true }];
  const start = { index: 0, done: false, remaining: 3, flash: false };
  const paused = sessionReducer(start, { type: "togglePause" }, items);
  expect(paused.paused).toBe(true);
  expect(sessionReducer(paused, { type: "tick" }, items)).toBe(paused);
  const moved = sessionReducer(paused, { type: "navigate", index: 1 }, items);
  expect(moved).toEqual({ index: 1, done: false, remaining: 5, flash: false, paused: true });
  expect(sessionReducer(moved, { type: "snooze", seconds: 30 }, items).paused).toBe(true);
  const resumed = sessionReducer(paused, { type: "togglePause" }, items);
  expect(sessionReducer(resumed, { type: "tick" }, items).remaining).toBe(2);
  expect(sessionReducer({ ...moved, done: true }, { type: "replay" }, items)).toEqual(start);
});
