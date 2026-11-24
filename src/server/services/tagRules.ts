import "server-only";
import fs from "node:fs";
import { z } from "zod";
import { EMPTY_RULES, sanitizeRules, validateRules, type TagRules } from "refr/lib/tag-rules";
import { paths } from "./dataDir";
import { readJson, writeJson } from "./jsonStore";

/** Storage for tag aliases + implications (`data/tag-rules.json`). Applying
 *  them lives in tags.ts; the pure logic in src/lib/tag-rules.ts. */

const rulesSchema = z.object({
  aliases: z.record(z.string(), z.string()).default({}),
  implications: z.record(z.string(), z.array(z.string())).default({}),
});

export class TagRulesInvalid extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}

// Re-read when the file's mtime changes so hand edits apply without a restart
// (same approach as config.get()).
let cache: { mtime: number; rules: TagRules } | null = null;

export function getRules(): TagRules {
  let mtime = 0;
  try {
    mtime = fs.statSync(paths.tagRules).mtimeMs;
  } catch {
    cache = null;
    return EMPTY_RULES;
  }
  if (cache?.mtime === mtime) return cache.rules;
  const rules = sanitizeRules(readJson(paths.tagRules, rulesSchema) ?? EMPTY_RULES);
  cache = { mtime, rules };
  return rules;
}

/** Validate and write. Throws TagRulesInvalid listing every problem. */
export function saveRules(input: TagRules): TagRules {
  const rules = sanitizeRules(input);
  const problems = validateRules(rules);
  if (problems.length) throw new TagRulesInvalid(problems);
  write(rules);
  return rules;
}

/** Rewrite after a tag rename/merge. Never throws on validation; a rewrite
 *  that makes a rule degenerate (self-implication) just drops it. */
export function updateRules(fn: (rules: TagRules) => TagRules) {
  const before = getRules();
  const after = sanitizeRules(fn(before));
  if (JSON.stringify(after) !== JSON.stringify(before)) write(after);
}

function write(rules: TagRules) {
  writeJson(paths.tagRules, rules);
  cache = null;
}
