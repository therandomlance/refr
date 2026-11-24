import { z } from "zod";
import { parseValueKeyword, type KEYWORD_NAMES } from "refr/lib/keywords";
import { normalize } from "refr/lib/tag-names";
import { resolveAlias, type TagRules } from "refr/lib/tag-rules";

/**
 * §9.1 token model + §9.2 grammar + §9.3 SQL translation.
 * Pure functions where possible (DB access injected) for testability.
 */

export const tokenSchema = z.object({
  kind: z.enum(["tag", "text", "similar"]).default("tag"),
  tag: z.string(),
  negate: z.boolean().default(false),
  exact: z.boolean().default(false),
  or: z.boolean().default(false),
  wildcard: z.boolean().default(false),
});

export type Token = z.infer<typeof tokenSchema>;

export function isVectorToken(token: Token): boolean {
  return token.kind === "text" || token.kind === "similar" || (token.kind === "tag" && token.tag.startsWith("suggest:"));
}

export function makeToken(partial: Partial<Token> & { tag: string }): Token {
  return tokenSchema.parse({ wildcard: partial.tag.includes("*"), ...partial });
}

// ---------------------------------------------------------------- grammar

/** Display/pretty string form. Chips are the source of truth; ?q= carries JSON.
 *  Similar chips (fileId-based) are omitted — they aren't text-expressible. */
export function serializeQuery(tokens: Token[]): string {
  return tokens
    .filter((t) => t.kind !== "similar")
    .map((t) => {
      if (t.kind === "text") return `"${t.tag}"`;
      let s = "";
      if (t.negate) s += "-";
      if (t.or) s += "~";
      if (t.exact) s += "=";
      return s + t.tag;
    })
    .join(" ");
}

/** Parse the pretty form. Chips are canonical (§9.2) — URLs carry JSON; this
 *  parser exists for hand-typed/shareable strings. Space splits terms except
 *  inside quotes; unquoted multi-word tags can't be expressed (use chips). */
export function parseQuery(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    let negate = false, or = false, exact = false;
    let sawMod = true;
    while (sawMod) {
      sawMod = false;
      if (s[i] === "-") { negate = true; i++; sawMod = true; }
      if (s[i] === "~") { or = true; i++; sawMod = true; }
    }
    if (s[i] === "=") { exact = true; i++; }
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      const value = s.slice(i + 1, end < 0 ? undefined : end);
      tokens.push(makeToken({ kind: "text", tag: value }));
      i = end < 0 ? s.length : end + 1;
      if (s[i] === " ") i++;
      continue;
    }
    let body = "";
    while (i < s.length && s[i] !== " ") body += s[i++]!;
    if (s[i] === " ") i++;
    if (body) tokens.push(makeToken({ tag: body, negate, or, exact }));
  }
  return tokens;
}

/** Build one token from a chip-input commit. When the commit came from an
 *  autocomplete row, `suggestion` is the atomic tag name — tag names may
 *  contain spaces, which the pretty parser would split, so build directly. */
export function commitToken(raw: string, suggestion?: string): Token | null {
  if (suggestion) {
    const mods = /^[-~=]*/.exec(raw)?.[0] ?? "";
    return makeToken({
      tag: suggestion,
      negate: mods.includes("-"),
      or: mods.includes("~"),
      exact: mods.includes("="),
    });
  }
  return parseQuery(raw)[0] ?? null;
}

// ---------------------------------------------------------------- SQL

export const PAGE_SIZE = 200;

export type Sort = "date" | "name" | "size" | "random" | "similarity";

type Sql = { text: string; params: unknown[] };

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** <tagCond> for one term against alias `t`. Returns SQL fragment + params. */
function tagCond(token: Token): Sql {
  if (token.wildcard) {
    const pattern = token.tag.split("*").map(escapeLike).join("%");
    return { text: `t.name LIKE ? ESCAPE '\\'`, params: [pattern] };
  }
  if (token.exact) {
    return { text: `t.name = ?`, params: [token.tag] };
  }
  return {
    text: `(t.name = ? OR t.name LIKE ? ESCAPE '\\')`,
    params: [token.tag, escapeLike(token.tag) + "/%"],
  };
}

function existsClause(cond: Sql, negate: boolean): Sql {
  return {
    text: `${negate ? "NOT " : ""}EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId WHERE ft.fileId = f.id AND ${cond.text})`,
    params: cond.params,
  };
}

/** `path:<dir>` keyword — files whose FilePath is <dir> or beneath it. Value-
 *  carrying, so handled before the zero-arg KEYWORDS registry. Negatable.
 *  `=path:` matches only the exact path or its direct children. Library aliases
 *  are resolved to real roots by `resolvePathAliases` before this runs. */
function pathClause(t: Token): Sql | null {
  if (t.wildcard || !t.tag.startsWith("path:")) return null;
  const p = t.tag.slice(5);
  if (!p) return null;
  const esc = p.replace(/[\\%_]/g, (c) => "\\" + c);
  if (t.exact) {
    return {
      text: `EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id AND (fp.path = ?
             OR (fp.path LIKE ? ESCAPE '\\' AND instr(substr(fp.path, ?), '/') = 0)))`,
      params: [p, esc + "/%", p.length + 2],
    };
  }
  return {
    text: `EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id AND (fp.path = ? OR fp.path LIKE ? ESCAPE '\\'))`,
    params: [p, esc + "/%"],
  };
}

/** Rewrite `path:<alias>` tokens to their resolved library roots. Run once at
 *  the API boundary so tag-SQL, semantic filtering, and timelines all agree. */
export function resolvePathAliases(
  tokens: Token[],
  aliases: Record<string, string>,
): Token[] {
  return tokens.map((t) =>
    t.kind === "tag" && t.tag.startsWith("path:")
      ? (() => {
          const root = aliases[t.tag.slice(5).toLowerCase()];
          return root ? { ...t, tag: "path:" + root } : t;
        })()
      : t,
  );
}

/** Rewrite tag chips (and `suggest:<tag>`) through the tag-rule aliases so a
 *  shorthand searches its target. Keywords, paths and wildcards are left alone. */
export function resolveTagAliases(tokens: Token[], rules: TagRules): Token[] {
  if (Object.keys(rules.aliases).length === 0) return tokens;
  const rewrite = (tag: string) => {
    const resolved = resolveAlias(rules, tag);
    return resolved === normalize(tag) ? tag : resolved;
  };
  return tokens.map((t) => {
    if (t.kind !== "tag" || t.wildcard || t.tag.startsWith("path:") || KEYWORDS[t.tag] || parseValueKeyword(t.tag)) return t;
    if (t.tag.startsWith("suggest:")) return { ...t, tag: "suggest:" + rewrite(t.tag.slice(8)) };
    return { ...t, tag: rewrite(t.tag) };
  });
}

/** Wallpaper-shaped images: at least 720 tall, aspect within a band (w/h).
 *  16:10 is 1.6, 16:9 is 1.778; "21:9" monitors are really 64:27 (2560×1080, 2.370) or
 *  43:18 (3440×1440, 2.389), so that band is centred on those, not 2.333. */
const WALLPAPER_BANDS = { "16:10": [1.56, 1.65], "16:9": [1.72, 1.84], "21:9": [2.3, 2.45] } as const;
function wallpaperSql(...bands: (keyof typeof WALLPAPER_BANDS)[]): Sql {
  const ratio = bands
    .map(() => `(f.width >= f.height * ? AND f.width <= f.height * ?)`)
    .join(" OR ");
  return {
    text: `(f.mediaType = 'image' AND f.height >= 720 AND (${ratio}))`,
    params: bands.flatMap((b) => [...WALLPAPER_BANDS[b]]),
  };
}

/** Metadata keywords (§9.3). Extensible: add a name to KEYWORD_NAMES (lib)
 *  and an entry here; unknown → literal tag. */
const KEYWORD_SQL: Record<(typeof KEYWORD_NAMES)[number], () => Sql> = {
  untagged: () => ({ text: `NOT EXISTS (SELECT 1 FROM FileTag ft WHERE ft.fileId = f.id)`, params: [] }),
  tagged: () => ({ text: `EXISTS (SELECT 1 FROM FileTag ft WHERE ft.fileId = f.id)`, params: [] }),
  // every known path has vanished (unmounted drive, deleted file) — row kept for its tags
  missing: () => ({ text: `NOT EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id)`, params: [] }),
  "type:image": () => ({ text: `f.mediaType = 'image'`, params: [] }),
  "type:video": () => ({ text: `f.mediaType = 'video'`, params: [] }),
  // bare `wallpaper` stays an ordinary tag
  "wallpaper:any": () => wallpaperSql("16:10", "16:9", "21:9"),
  "wallpaper:16:9": () => wallpaperSql("16:9"),
  "wallpaper:16:10": () => wallpaperSql("16:10"),
  "wallpaper:21:9": () => wallpaperSql("21:9"),
  // ±2% counts as square so 1000×1010 crops don't land in portrait
  "orient:landscape": () => ({ text: `f.width > f.height * 1.02`, params: [] }),
  "orient:portrait": () => ({ text: `f.height > f.width * 1.02`, params: [] }),
  "orient:square": () => ({ text: `f.width <= f.height * 1.02 AND f.height <= f.width * 1.02`, params: [] }),
};

/** Value-carrying keywords (`w>2000`, `tags=0`, `added:7d`, `date:2024-03`) —
 *  grammar in parseValueKeyword (lib, client-safe). `=` exact is meaningless
 *  here and ignored; negation is applied by the caller. Dates are epoch ms. */
function valueKeywordClause(t: Token): Sql | null {
  if (t.wildcard) return null;
  const k = parseValueKeyword(t.tag);
  if (!k) return null;
  switch (k.kind) {
    case "dim":
      // unknown dimensions never match either way round
      return { text: `(f.${k.field} IS NOT NULL AND f.${k.field} ${k.op} ?)`, params: [k.n] };
    case "tags":
      return { text: `(SELECT COUNT(*) FROM FileTag ft WHERE ft.fileId = f.id) ${k.op} ?`, params: [k.n] };
    case "added":
      return { text: `f.addedAt >= ?`, params: [Date.now() - k.days * 86_400_000] };
    case "date":
      return { text: `(f.mtime >= ? AND f.mtime < ?)`, params: [k.from.getTime(), k.to.getTime()] };
  }
}

export const KEYWORDS: Record<string, () => Sql> = KEYWORD_SQL;

function tokenClause(t: Token): Sql {
  const pc = pathClause(t) ?? valueKeywordClause(t);
  if (pc) return t.negate ? { text: `NOT (${pc.text})`, params: pc.params } : pc;
  const kw = KEYWORDS[t.tag];
  if (kw && !t.exact && !t.wildcard) {
    const k = kw();
    return { text: t.negate ? `NOT (${k.text})` : k.text, params: k.params };
  }
  return existsClause(tagCond(t), t.negate);
}

/**
 * Translate tag tokens to a WHERE clause (without leading WHERE).
 * AND for plain terms, one OR group for all ~terms, NOT for -terms.
 */
export function tokensToWhere(tokens: Token[]): Sql {
  const tagTokens = tokens.filter((t) => t.kind === "tag");
  const clauses: string[] = [];
  const params: unknown[] = [];

  const positive = tagTokens.filter((t) => !t.negate && !t.or);
  const negated = tagTokens.filter((t) => t.negate);
  const ors = tagTokens.filter((t) => !t.negate && t.or);

  for (const t of [...positive, ...negated]) {
    const c = tokenClause(t);
    clauses.push(c.text);
    params.push(...c.params);
  }
  if (ors.length > 0) {
    const parts = ors.map(tokenClause);
    clauses.push("(" + parts.map((p) => p.text).join(" OR ") + ")");
    params.push(...parts.flatMap((p) => p.params));
  }

  return { text: clauses.length ? clauses.join(" AND ") : "1=1", params };
}

// ---------------------------------------------------------------- list query

export type FileSummary = {
  id: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  mtime: number; // ms epoch — grids group by it
};

export type ListInput = {
  where?: Sql; // extra WHERE clause (e.g. tokensToWhere, path prefix, explicit ids)
  sort: Sort;
  cursor?: string | null;
  limit?: number;
};

export type ListResult = {
  items: FileSummary[];
  nextCursor: string | null;
  /** Set only on a seek/backward page: cursor for the page immediately newer. */
  prevCursor?: string | null;
};

const SUMMARY_COLS = `f.id, f.mediaType, f.width, f.height, f.duration, f.mtime`;

/**
 * Build the shared list query (§9.4). Keyset for date, offset for name/size,
 * seeded-random with offset for random.
 */
export function buildListQuery(input: ListInput): Sql {
  const limit = input.limit ?? PAGE_SIZE;
  const where = input.where?.text ?? "1=1";
  const params: unknown[] = [...(input.where?.params ?? [])];

  if (input.sort === "date" || input.sort === "similarity") {
    // cursor prefixes: plain = older (forward page), "!" = seek anchor,
    // "^" = newer (backward page, used when scrolling up)
    const cursor = input.cursor ?? null;
    const backward = cursor?.startsWith("^") ?? false;
    const raw = cursor ? cursor.replace(/^[!^]/, "") : null;
    let text = `SELECT ${SUMMARY_COLS} FROM File f WHERE ${where}`;
    if (raw) {
      const [mtime, id] = raw.split("|");
      text += backward
        ? ` AND (f.mtime, f.id) > (?, ?)`
        : ` AND (f.mtime, f.id) < (?, ?)`;
      params.push(Number(mtime), id);
    }
    text += backward
      ? ` ORDER BY f.mtime ASC, f.id ASC LIMIT ?`
      : ` ORDER BY f.mtime DESC, f.id DESC LIMIT ?`;
    params.push(limit + 1);
    return { text, params };
  }

  if (input.sort === "name") {
    const offset = input.cursor ? Number(input.cursor) : 0;
    return {
      text: `SELECT ${SUMMARY_COLS} FROM File f WHERE ${where}
             ORDER BY (SELECT MIN(p.path) FROM FilePath p WHERE p.fileId = f.id) ASC, f.id ASC
             LIMIT ? OFFSET ?`,
      params: [...params, limit + 1, offset],
    };
  }

  if (input.sort === "size") {
    const offset = input.cursor ? Number(input.cursor) : 0;
    return {
      text: `SELECT ${SUMMARY_COLS} FROM File f WHERE ${where} ORDER BY f.size DESC, f.id ASC LIMIT ? OFFSET ?`,
      params: [...params, limit + 1, offset],
    };
  }

  // random — duplicates across pages accepted (ponytail §9.4)
  const offset = input.cursor ? Number(input.cursor) : 0;
  return {
    text: `SELECT ${SUMMARY_COLS} FROM File f WHERE ${where} ORDER BY RANDOM() LIMIT ? OFFSET ?`,
    params: [...params, limit + 1, offset],
  };
}

/** Cursor for the next page given a finished page. */
export function nextCursorFor(
  sort: Sort,
  items: FileSummary[],
  prevCursor: string | null | undefined,
  rawRows: { mtime?: Date }[],
): string | null {
  if (items.length === 0) return null;
  if (sort === "date" || sort === "similarity") {
    const last = rawRows[rawRows.length - 1];
    const lastId = items[items.length - 1]!.id;
    if (!last?.mtime) return null;
    return `${last.mtime.getTime()}|${lastId}`;
  }
  if (sort === "random") {
    const prevOffset = prevCursor ? Number(prevCursor) : 0;
    return String(prevOffset + items.length);
  }
  const prevOffset = prevCursor ? Number(prevCursor) : 0;
  return String(prevOffset + items.length);
}
