import { describe, expect, it } from "vitest";
import { matchFileShortcut } from "refr/lib/keyboard";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("matchFileShortcut", () => {
  it("maps plain letters to tile actions", () => {
    expect(matchFileShortcut(key("q"))).toBe("queue");
    expect(matchFileShortcut(key("t"))).toBe("addTag");
    expect(matchFileShortcut(key("p"))).toBe("palette");
    expect(matchFileShortcut(key("s"))).toBe("sendTo");
  });

  it("distinguishes Shift+T from T", () => {
    expect(matchFileShortcut(key("T", { shiftKey: true }))).toBe("removeTag");
  });

  it("leaves browser shortcuts alone", () => {
    expect(matchFileShortcut(key("t", { ctrlKey: true }))).toBeNull();
    expect(matchFileShortcut(key("p", { metaKey: true }))).toBeNull();
    expect(matchFileShortcut(key("s", { ctrlKey: true }))).toBeNull();
    expect(matchFileShortcut(key("q", { altKey: true }))).toBeNull();
  });

  it("matches invert and queue moves only with their modifiers", () => {
    expect(matchFileShortcut(key("i", { ctrlKey: true }))).toBe("invert");
    expect(matchFileShortcut(key("i", { metaKey: true }))).toBe("invert");
    expect(matchFileShortcut(key("i"))).toBeNull();
    expect(matchFileShortcut(key("ArrowLeft", { altKey: true }))).toBe("moveUp");
    expect(matchFileShortcut(key("ArrowRight", { altKey: true }))).toBe("moveDown");
    expect(matchFileShortcut(key("Home", { altKey: true }))).toBe("moveStart");
    expect(matchFileShortcut(key("End", { altKey: true }))).toBe("moveEnd");
    expect(matchFileShortcut(key("ArrowLeft"))).toBeNull();
  });
});
