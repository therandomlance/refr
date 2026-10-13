import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { TimelineScrubber } from "refr/app/_components/timeline-scrubber";

// Exercise pointer handlers without adding a DOM dependency.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
  useMemo: (compute: () => unknown) => compute(),
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.values[index] ??= { current: initial };
    return hooks.values[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  },
}));

it("seeks during captured drags, follows the pointer, and lands exactly on release", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  hooks.values = [undefined, undefined, 242]; // 200px track + padding
  const buckets = [2025, 2024].map((year) => ({ year, month: 1, count: 10, minMtime: 0, maxMtime: 100 }));
  const onSeek = vi.fn();
  type Node = ReactElement<Record<string, unknown>>;
  const render = () => {
    hooks.index = 0;
    const node = TimelineScrubber({ buckets, active: null, onSeek, controls: "grid" });
    const track = node.props.children.at(-1) as Node;
    (track.props.ref as { current: unknown }).current = { getBoundingClientRect: () => ({ top: 32 }) };
    return node;
  };
  let captured = false;
  const currentTarget = {
    focus: vi.fn(),
    setPointerCapture: () => { captured = true; },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => { captured = false; },
  };
  const event = (clientY: number, type = "pointermove", button = 0) => ({
    clientY, type, button, isPrimary: true, pointerId: 1, currentTarget, preventDefault: vi.fn(),
  }) as unknown as React.PointerEvent<HTMLDivElement>;
  try {
    render().props.onPointerDown(event(57, "pointerdown", 2));
    expect(onSeek).not.toHaveBeenCalled();
    render().props.onPointerDown(event(57, "pointerdown"));
    expect(onSeek).toHaveBeenLastCalledWith(buckets[0], 0.25);
    vi.advanceTimersByTime(80);
    render().props.onPointerMove(event(182));
    expect(onSeek).toHaveBeenLastCalledWith(buckets[1], 0.5);
    const bubble = render().props.children[0] as Node;
    expect(bubble.props.style).toEqual({ top: 174 });
    render().props.onPointerMove(event(207));
    expect(onSeek).toHaveBeenCalledTimes(2); // previews are rate-limited
    render().props.onPointerUp(event(222, "pointerup"));
    expect(onSeek).toHaveBeenLastCalledWith(buckets[1], 0.9);
    expect(captured).toBe(false);
    render().props.onPointerMove(event(57));
    expect(onSeek).toHaveBeenCalledTimes(3); // hover does not seek

    render().props.onPointerDown(event(-50, "pointerdown"));
    expect(onSeek).toHaveBeenLastCalledWith(buckets[0], 0);
    render().props.onPointerCancel(event(500, "pointercancel"));
    expect(onSeek).toHaveBeenCalledTimes(4); // cancellation doesn't commit
    render().props.onPointerDown(event(500, "pointerdown"));
    expect(onSeek).toHaveBeenLastCalledWith(buckets[1], 1);
    render().props.onPointerUp(event(500, "pointerup"));
  } finally {
    vi.useRealTimers();
  }
});
