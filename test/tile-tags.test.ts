import { describe, expect, it } from "vitest";
import { tileTagBadges } from "refr/lib/tagging";

describe("tileTagBadges", () => {
  it("drops the browsed tag and its ancestors, shows descendants relative to it", () => {
    const names = ["reference", "reference/figure", "reference/figure/arms", "nsfw", "artwork/fanart/warframe/loki"];
    expect(tileTagBadges(names, "reference/figure")).toEqual([
      { label: "arms", full: "reference/figure/arms" },
      { label: "nsfw", full: "nsfw" },
      { label: "…/warframe/loki", full: "artwork/fanart/warframe/loki" },
    ]);
  });
  it("without a context keeps every tag (shortened)", () => {
    expect(tileTagBadges(["a", "a/b/c"]).map((b) => b.label)).toEqual(["a", "…/b/c"]);
  });
  it("does not treat a name prefix as an ancestor", () => {
    expect(tileTagBadges(["ref", "reference/x"], "reference").map((b) => b.label)).toEqual(["ref", "x"]);
  });
});
