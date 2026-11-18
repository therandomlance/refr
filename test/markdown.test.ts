import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, toggleWrap } from "refr/lib/markdown";

describe("parseInline", () => {
  it("bold, italic, strike, code, links", () => {
    expect(parseInline("a **b** *c* _d_ ~~e~~ `f*g*` [h](https://x.y)")).toEqual([
      { t: "text", v: "a " }, { t: "b", c: [{ t: "text", v: "b" }] }, { t: "text", v: " " },
      { t: "i", c: [{ t: "text", v: "c" }] }, { t: "text", v: " " },
      { t: "i", c: [{ t: "text", v: "d" }] }, { t: "text", v: " " },
      { t: "s", c: [{ t: "text", v: "e" }] }, { t: "text", v: " " },
      { t: "code", v: "f*g*" }, { t: "text", v: " " },
      { t: "a", href: "https://x.y", c: [{ t: "text", v: "h" }] },
    ]);
  });

  it("nests and keeps unmatched markers literal", () => {
    expect(parseInline("**bold *it***")).toEqual([{ t: "b", c: [{ t: "text", v: "bold " }, { t: "i", c: [{ t: "text", v: "it" }] }] }]);
    expect(parseInline("2 * 3 = 6")).toEqual([{ t: "text", v: "2 * 3 = 6" }]);
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
    expect(parseInline("\\*not\\*")).toEqual([{ t: "text", v: "*not*" }]);
  });

  it("refuses unsafe link schemes", () => {
    expect(parseInline("[x](javascript:alert(1))").some((n) => n.t === "a")).toBe(false);
  });
});

describe("parseMarkdown", () => {
  it("blocks", () => {
    const b = parseMarkdown("# Title\nline one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n> quote\n\n---\n```\ncode *raw*\n```");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol", "quote", "hr", "pre"]);
    expect(b[1]).toEqual({ t: "p", c: [{ t: "text", v: "line one" }, { t: "br" }, { t: "text", v: "line two" }] });
    expect(b[2]).toMatchObject({ t: "ul", items: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] });
    expect(b[6]).toEqual({ t: "pre", v: "code *raw*" });
  });
});

describe("toggleWrap", () => {
  const apply = (s: string, m: "**" | "*") => {
    // [ ] mark the selection in the fixture
    const start = s.indexOf("[");
    const end = s.indexOf("]") - 1;
    const r = toggleWrap(s.replace("[", "").replace("]", ""), start, end, m);
    return r.value.slice(0, r.start) + "[" + r.value.slice(r.start, r.end) + "]" + r.value.slice(r.end);
  };
  it("wraps, unwraps, and nests", () => {
    expect(apply("a [word] b", "**")).toBe("a **[word]** b");
    expect(apply("a **[word]** b", "**")).toBe("a [word] b");
    expect(apply("a [**word**] b", "**")).toBe("a [word] b");
    expect(apply("a [word] b", "*")).toBe("a *[word]* b");
    expect(apply("a *[word]* b", "*")).toBe("a [word] b");
    expect(apply("a **[word]** b", "*")).toBe("a ***[word]*** b");
    expect(apply("a ***[word]*** b", "*")).toBe("a **[word]** b");
    expect(apply("a ***[word]*** b", "**")).toBe("a *[word]* b");
  });
  it("empty selection inserts a pair with the caret inside", () => {
    expect(apply("ab[]c", "**")).toBe("ab**[]**c");
  });
});
