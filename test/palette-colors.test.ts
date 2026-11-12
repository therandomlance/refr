import { expect, it } from "vitest";
import { contrast, exportFileName, normalizeHex, reorderColor } from "refr/lib/palette-colors";

it("moves swatches in both directions without mutating or confusing duplicate colors", () => {
  const colors = ["#ffffff", "#000000", "#ffffff", "#ff0000"];
  expect(reorderColor(colors, 0, 3)).toEqual(["#000000", "#ffffff", "#ff0000", "#ffffff"]);
  expect(reorderColor(colors, 3, 1)).toEqual(["#ffffff", "#ff0000", "#000000", "#ffffff"]);
  expect(colors).toEqual(["#ffffff", "#000000", "#ffffff", "#ff0000"]);
  for (const [from, to] of [[0, -1], [3, 4], [-1, 0], [4, 0], [1, 1]]) {
    expect(reorderColor(colors, from!, to!)).toBe(colors);
  }
});

it("normalizes hex input: shorthand, missing #, case, whitespace", () => {
  expect(normalizeHex("abc")).toBe("#aabbcc");
  expect(normalizeHex(" #A1B2C3 ")).toBe("#a1b2c3");
  expect(normalizeHex("#F0f")).toBe("#ff00ff");
  for (const bad of ["", "#12345", "ggg", "#1234567", "rgb(1,2,3)"]) expect(normalizeHex(bad)).toBeNull();
});

it("contrast picks readable text and export names are filesystem-safe", () => {
  expect(contrast("#ffffff")).toBe("#000");
  expect(contrast("#101010")).toBe("#fff");
  expect(exportFileName("a/b:c", "png")).toBe("a_b_c.png");
  expect(exportFileName("  ", "png")).toBe("palette.png");
});
