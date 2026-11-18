import { describe, expect, it } from "vitest";
import { matchFileShortcut, matchViewerShortcut, VIEWER_SHORTCUTS } from "refr/lib/keyboard";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("matchFileShortcut", () => {
  it("maps plain letters to tile actions", () => {
    expect(matchFileShortcut(key("q"))).toBe("queue");
    expect(matchFileShortcut(key("t"))).toBe("addTag");
    expect(matchFileShortcut(key("p"))).toBe("palette");
    expect(matchFileShortcut(key("s"))).toBe("sendTo");
    expect(matchFileShortcut(key("b"))).toBe("addToBoard");
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

describe("VIEWER_SHORTCUTS", () => {
  // every viewer key, as the event it is meant to match
  const viewerEvents = (Object.keys(VIEWER_SHORTCUTS) as (keyof typeof VIEWER_SHORTCUTS)[]).map((name) => {
    const hint = VIEWER_SHORTCUTS[name].hint();
    const k = ({ "←": "ArrowLeft", "→": "ArrowRight", Esc: "Escape" } as Record<string, string>)[hint] ?? hint.toLowerCase();
    return { name, e: key(k) };
  });

  it("each hint round-trips to its own action", () => {
    for (const { name, e } of viewerEvents) expect(matchViewerShortcut(e)).toBe(name);
  });

  it("never claims a thumbnail context-action key (those keep precedence)", () => {
    for (const { e } of viewerEvents) expect(matchFileShortcut(e)).toBeNull();
    for (const k of ["q", "t", "p", "s", "b"]) expect(matchViewerShortcut(key(k))).toBeNull();
    expect(matchViewerShortcut(key("T", { shiftKey: true }))).toBeNull();
  });

  it("stays clear of the session runner's keys", () => {
    for (const k of [" ", "n", "+", "="]) expect(matchViewerShortcut(key(k))).toBeNull();
  });

  it("ignores modified letters", () => {
    expect(matchViewerShortcut(key("h", { ctrlKey: true }))).toBeNull();
    expect(matchViewerShortcut(key("G", { shiftKey: true }))).toBeNull();
  });
});
