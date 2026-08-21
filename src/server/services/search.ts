import { z } from "zod";
import type { KEYWORD_NAMES } from "refr/lib/keywords";

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
 *  carrying, so handled before the zero-arg KEYWORDS registry. Negatable. */
function pathClause(t: Token): Sql | null {
  if (t.exact || t.wildcard || !t.tag.startsWith("path:")) return null;
  const p = t.tag.slice(5);
  if (!p) return null;
  const esc = p.replace(/[\\%_]/g, (c) => "\\" + c);
  return {
    text: `EXISTS (SELECT 1 FROM FilePath fp WHERE fp.fileId = f.id AND (fp.path = ? OR fp.path LIKE ? ESCAPE '\\'))`,
    params: [p, esc + "/%"],
  };
}

/** Metadata keywords (§9.3). Extensible: add a name to KEYWORD_NAMES (lib)
 *  and an entry here; unknown → literal tag. */
const KEYWORD_SQL: Record<(typeof KEYWORD_NAMES)[number], () => Sql> = {
  untagged: () => ({ text: `NOT EXISTS (SELECT 1 FROM FileTag ft WHERE ft.fileId = f.id)`, params: [] }),
  tagged: () => ({ text: `EXISTS (SELECT 1 FROM FileTag ft WHERE ft.fileId = f.id)`, params: [] }),
};

export const KEYWORDS: Record<string, () => Sql> = KEYWORD_SQL;

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

  for (const t of positive) {
    const pc = pathClause(t);
    if (pc) { clauses.push(pc.text); params.push(...pc.params); continue; }
    const kw = KEYWORDS[t.tag];
    if (kw && !t.exact && !t.wildcard) {
      const k = kw();
      clauses.push(t.negate ? `NOT (${k.text})` : k.text);
      params.push(...k.params);
      continue;
    }
    const c = existsClause(tagCond(t), false);
    clauses.push(c.text);
    params.push(...c.params);
  }
  for (const t of negated) {
    const pc = pathClause(t);
    if (pc) { clauses.push(`NOT (${pc.text})`); params.push(...pc.params); continue; }
    const kw = KEYWORDS[t.tag];
    if (kw && !t.exact && !t.wildcard) {
      const k = kw();
      clauses.push(`NOT (${k.text})`);
      params.push(...k.params);
      continue;
    }
    const c = existsClause(tagCond(t), true);
    clauses.push(c.text);
    params.push(...c.params);
  }
  if (ors.length > 0) {
    const parts = ors.map((t) => existsClause(tagCond(t), false));
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

export type ListResult = { items: FileSummary[]; nextCursor: string | null };

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
    let text = `SELECT ${SUMMARY_COLS} FROM File f WHERE ${where}`;
    if (input.cursor) {
      const [mtime, id] = input.cursor.split("|");
      // Prisma stores SQLite DateTime as integer ms — numeric comparison
      text += ` AND (f.mtime < ? OR (f.mtime = ? AND f.id < ?))`;
      params.push(Number(mtime), Number(mtime), id);
    }
    text += ` ORDER BY f.mtime DESC, f.id DESC LIMIT ?`;
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
