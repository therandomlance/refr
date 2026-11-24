"use client";

import { Icon } from "./icon";
import { TagInput } from "./tag-input";
import { KEYWORD_HINTS, KEYWORD_NAMES } from "refr/lib/keywords";
import { commitToken, type Token } from "refr/server/services/search";

/**
 * Compact search-chip editor: the search bar's tag grammar (-not, ~or, =exact,
 * wildcards, keywords, path:) without vector chips. Used by session blocks.
 */
export function TokenField({
  tokens,
  onChange,
  placeholder = "Tags, -exclude, keywords…",
  label,
}: {
  tokens: Token[];
  onChange: (tokens: Token[]) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label={label}>
      {tokens.map((t, i) => (
        <span key={i} className="chip">
          {(t.negate || t.or || t.exact) && (
            <span className="mod">{t.negate ? "-" : ""}{t.or ? "~" : ""}{t.exact ? "=" : ""}</span>
          )}
          {t.tag}
          <button className="x" aria-label={`Remove ${t.tag}`} onClick={() => onChange(tokens.filter((_, j) => j !== i))}>
            <Icon name="close" />
          </button>
        </span>
      ))}
      <div className="min-w-32 flex-1">
        <TagInput
          placeholder={tokens.length ? "" : placeholder}
          keywords={KEYWORD_NAMES}
          keywordHints={KEYWORD_HINTS}
          pathAutocomplete
          onCommit={(raw, suggestion) => {
            // semantic fallback rows arrive quote-prefixed; sessions only take tag chips
            if (raw.startsWith('"')) return;
            const token = commitToken(raw, suggestion);
            if (token?.kind === "tag" && !token.tag.startsWith("suggest:")) onChange([...tokens, token]);
          }}
        />
      </div>
    </div>
  );
}
