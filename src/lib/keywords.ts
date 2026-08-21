/** Metadata keyword names (§9.3) — surfaced in the search autocomplete.
 *  Their SQL lives in KEYWORDS (src/server/services/search.ts); keep this
 *  list and that registry's keys in sync. Unknown → literal tag. */
export const KEYWORD_NAMES = ["untagged", "tagged"] as const;
