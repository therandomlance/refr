/**
 * Tiny markdown subset for board text boxes → a plain AST (rendered as React
 * elements, never raw HTML). Blocks: `#`–`###` headings, paragraphs (single
 * newlines become line breaks), `-`/`*` and `1.` lists, `>` quotes, ``` fences,
 * `---` rules. Inline: **bold**, *italic* / _italic_, ~~strike~~, `code`,
 * [text](http/https/mailto url).
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b" | "i" | "s"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "quote"; c: Block[] }
  | { t: "pre"; v: string }
  | { t: "hr" };

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** `**…**` closing at the first `**` that leaves balanced single `*`s inside,
 *  so `**bold *it***` nests instead of closing early. */
function boldMatch(rest: string): RegExpExecArray | null {
  if (!/\S/.test(rest[2] ?? "")) return null;
  for (let j = rest.indexOf("**", 3); j !== -1; j = rest.indexOf("**", j + 1)) {
    const inner = rest.slice(2, j);
    if (/\s$/.test(inner) || (inner.match(/\*/g)?.length ?? 0) % 2 !== 0) continue;
    const m = [rest.slice(0, j + 2), inner] as unknown as RegExpExecArray;
    return m;
  }
  return null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (rest.startsWith("\\") && rest.length > 1 && /[\\`*_~[\]()#>-]/.test(rest[1]!)) {
      text += rest[1];
      i += 2;
    } else if (rest.startsWith("\n")) {
      flush(); out.push({ t: "br" }); i++;
    } else if ((m = /^`([^`]+)`/.exec(rest))) {
      flush(); out.push({ t: "code", v: m[1]! }); i += m[0].length;
    } else if (rest.startsWith("**") && (m = boldMatch(rest))) {
      flush(); out.push({ t: "b", c: parseInline(m[1]!) }); i += m[0].length;
    } else if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      flush(); out.push({ t: "s", c: parseInline(m[1]!) }); i += m[0].length;
    } else if ((m = /^\*([^\s*](?:[\s\S]*?[^\s*])??)\*(?!\*)/.exec(rest)) || (m = /^_(\S(?:[\s\S]*?\S)??)_(?![A-Za-z0-9])/.exec(rest))) {
      flush(); out.push({ t: "i", c: parseInline(m[1]!) }); i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)) && SAFE_URL.test(m[2]!)) {
      flush(); out.push({ t: "a", href: m[2]!, c: parseInline(m[1]!) }); i += m[0].length;
    } else {
      text += rest[0];
      i++;
    }
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if (line.startsWith("```")) {
      endPara();
      const body: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i]!);
      blocks.push({ t: "pre", v: body.join("\n") });
    } else if (!line.trim()) {
      endPara();
    } else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      endPara();
      blocks.push({ t: "h", level: m[1]!.length as 1 | 2 | 3, c: parseInline(m[2]!) });
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      endPara();
      blocks.push({ t: "hr" });
    } else if (/^>\s?/.test(line)) {
      endPara();
      const body: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^>\s?/, ""));
      i--;
      blocks.push({ t: "quote", c: parseMarkdown(body.join("\n")) });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      endPara();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: Inline[][] = [];
      const itemRe = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      for (; i < lines.length; i++) {
        const im = itemRe.exec(lines[i]!);
        if (!im) break;
        items.push(parseInline(im[1]!));
      }
      i--;
      blocks.push({ t: ordered ? "ol" : "ul", items });
    } else {
      para.push(line);
    }
  }
  endPara();
  return blocks;
}

/**
 * Ctrl+B / Ctrl+I in a text box: toggle `**` / `*` around the selection.
 * Already-wrapped selections (markers just outside, or included in the
 * selection) are unwrapped; bold and italic nest (`***x***`). With no
 * selection, inserts a marker pair and puts the caret between.
 */
export function toggleWrap(
  value: string,
  start: number,
  end: number,
  marker: "**" | "*",
): { value: string; start: number; end: number } {
  const L = marker.length;
  const run = (from: number, step: 1 | -1) => {
    let n = 0;
    for (let i = from; i >= 0 && i < value.length && value[i] === "*"; i += step) n++;
    return n;
  };
  const k = Math.min(run(start - 1, -1), run(end, 1));
  const active = marker === "**" ? k >= 2 : k % 2 === 1;
  if (start !== end && active) {
    return { value: value.slice(0, start - L) + value.slice(start, end) + value.slice(end + L), start: start - L, end: end - L };
  }
  const sel = value.slice(start, end);
  const inner = run(start, 1) >= L && run(end - 1, -1) >= L && sel.length >= 2 * L + 1;
  if (inner && (marker === "**" || run(start, 1) % 2 === 1)) {
    return { value: value.slice(0, start) + sel.slice(L, -L) + value.slice(end), start, end: end - 2 * L };
  }
  return { value: value.slice(0, start) + marker + sel + marker + value.slice(end), start: start + L, end: end + L };
}
