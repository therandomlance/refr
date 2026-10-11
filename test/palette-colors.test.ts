import { expect, it } from "vitest";
import { reorderColor } from "refr/lib/palette-colors";

it("moves swatches in both directions without mutating or confusing duplicate colors", () => {
  const colors = ["#ffffff", "#000000", "#ffffff", "#ff0000"];
  expect(reorderColor(colors, 0, 3)).toEqual(["#000000", "#ffffff", "#ff0000", "#ffffff"]);
  expect(reorderColor(colors, 3, 1)).toEqual(["#ffffff", "#ff0000", "#000000", "#ffffff"]);
  expect(colors).toEqual(["#ffffff", "#000000", "#ffffff", "#ff0000"]);
  for (const [from, to] of [[0, -1], [3, 4], [-1, 0], [4, 0], [1, 1]]) {
    expect(reorderColor(colors, from!, to!)).toBe(colors);
  }
});
