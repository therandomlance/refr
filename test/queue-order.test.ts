import { expect, it } from "vitest";
import { moveQueueItems } from "refr/lib/queue-order";

it("moves queue selections one slot and preserves order at boundaries", () => {
  const ids = ["a", "b", "c", "d", "e"];
  expect(moveQueueItems(ids, new Set(["b", "c"]), -1)).toEqual(["b", "c", "a", "d", "e"]);
  expect(moveQueueItems(ids, new Set(["b", "c"]), 1)).toEqual(["a", "d", "b", "c", "e"]);
  expect(moveQueueItems(ids, new Set(["a", "c"]), -1)).toEqual(["a", "c", "b", "d", "e"]);
  expect(moveQueueItems(ids, new Set(["c", "e"]), 1)).toEqual(["a", "b", "d", "c", "e"]);
  expect(moveQueueItems(ids, new Set(ids), 1)).toEqual(ids);
  expect(moveQueueItems([], new Set(), -1)).toEqual([]);
  expect(ids).toEqual(["a", "b", "c", "d", "e"]);
});
