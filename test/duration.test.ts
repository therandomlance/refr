import { expect, it } from "vitest";
import { formatDurationInput, parseDuration } from "refr/lib/duration";

it("keeps duration drafts parseable without coercing incomplete input", () => {
  expect(parseDuration("1")).toBe(1);
  expect(parseDuration("1:")).toBeUndefined();
  expect(parseDuration("1:30")).toBe(90);
  expect(parseDuration("90")).toBe(90);
  expect(formatDurationInput(90)).toBe("1:30");
  expect(parseDuration("")).toBeNull();
  for (const invalid of ["1:60", "-1", "abc", "0", "99999999999999999999"]) expect(parseDuration(invalid)).toBeUndefined();
});
