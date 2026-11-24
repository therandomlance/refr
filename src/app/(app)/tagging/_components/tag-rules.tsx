"use client";

import { useState } from "react";
import { api } from "refr/trpc/react";
import { Dialog } from "refr/app/_components/dialog";
import { Icon } from "refr/app/_components/icon";
import { TagInput } from "refr/app/_components/tag-input";
import { useActionFeedback } from "refr/app/_components/action-feedback";
import { normalize } from "refr/lib/tag-names";
import { EMPTY_RULES, sanitizeRules, validateRules, type TagRules } from "refr/lib/tag-rules";

/**
 * Tagging → Rules: tag aliases (`fig → reference/figure`) and implications
 * (`artist/x ⇒ medium/digital`). Every edit is validated with the same pure
 * functions the server uses, then saved straight to data/tag-rules.json.
 */
export function TagRulesEditor() {
  const utils = api.useUtils();
  const notify = useActionFeedback();
  const rulesQ = api.tagRules.get.useQuery();
  const save = api.tagRules.save.useMutation({
    meta: { customFeedback: true },
    onSuccess: (rules) => utils.tagRules.get.setData(undefined, rules),
  });
  const apply = api.tagRules.applyToExisting.useMutation({
    meta: { customFeedback: true },
    onSuccess: ({ renamedTags, changedFiles }) => {
      void utils.invalidate();
      notify({
        message: renamedTags || changedFiles
          ? `Renamed ${renamedTags} tag${renamedTags === 1 ? "" : "s"}, updated ${changedFiles} file${changedFiles === 1 ? "" : "s"}.`
          : "Everything already follows the rules.",
      });
    },
  });
  const [problems, setProblems] = useState<string[]>([]);
  const [aliasFrom, setAliasFrom] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  // an implication row picked but not yet given any implied tags (not saved until it has one)
  const [pendingTag, setPendingTag] = useState<string | null>(null);

  const rules = rulesQ.data ?? EMPTY_RULES;

  const commit = (next: TagRules) => {
    const clean = sanitizeRules(next);
    const errors = validateRules(clean);
    setProblems(errors);
    if (errors.length === 0) save.mutate(clean, { onError: (e) => setProblems(e.message.split("\n")) });
  };

  const aliases = Object.entries(rules.aliases).sort(([a], [b]) => a.localeCompare(b));
  const implications = Object.entries(rules.implications).sort(([a], [b]) => a.localeCompare(b));
  if (pendingTag && !rules.implications[pendingTag]) implications.unshift([pendingTag, []]);

  const setImplied = (tag: string, implied: string[]) => {
    const next = { ...rules.implications, [tag]: implied };
    if (implied.length === 0) delete next[tag];
    if (tag === pendingTag && implied.length) setPendingTag(null);
    commit({ ...rules, implications: next });
  };

  if (!rulesQ.data) return <p className="px-5 py-4 text-sm text-fg-subtle">Loading…</p>;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
      <div className="flex max-w-3xl flex-col gap-8">
        {problems.length > 0 && (
          <div role="alert" className="card border-danger px-4 py-3 text-sm text-danger">
            {problems.map((p) => <p key={p}>{p}</p>)}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Aliases</h2>
            <p className="text-xs text-fg-subtle">
              A shorthand that always means another tag, when tagging and searching. <code>fig/arms</code> becomes{" "}
              <code>reference/figure/arms</code> if <code>fig</code> is an alias for <code>reference/figure</code>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input w-44"
              placeholder="Shorthand"
              aria-label="Alias shorthand"
              value={aliasFrom}
              onChange={(e) => setAliasFrom(e.target.value)}
            />
            <span className="text-fg-subtle">→</span>
            <div className="min-w-56 flex-1">
              <TagInput
                placeholder={aliasFrom.trim() ? `Tag "${normalize(aliasFrom)}" stands for…` : "Target tag…"}
                onCommit={(raw, suggestion) => {
                  const from = normalize(aliasFrom);
                  const to = normalize(suggestion ?? raw);
                  if (!from || !to) return;
                  commit({ ...rules, aliases: { ...rules.aliases, [from]: to } });
                  setAliasFrom("");
                }}
              />
            </div>
          </div>
          {aliases.length > 0 ? (
            <ul className="card divide-y divide-line">
              {aliases.map(([from, to]) => (
                <li key={from} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <code className="text-fg-muted">{from}</code>
                  <span className="text-fg-subtle">→</span>
                  <span className="min-w-0 flex-1 truncate">{to}</span>
                  <button
                    className="btn ghost sm"
                    aria-label={`Remove alias ${from}`}
                    onClick={() => {
                      const next = { ...rules.aliases };
                      delete next[from];
                      commit({ ...rules, aliases: next });
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-subtle">No aliases yet.</p>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Implications</h2>
            <p className="text-xs text-fg-subtle">
              Adding a tag, or any tag beneath it, also adds the tags it implies, and theirs in turn. Files that already
              carry an implied tag or one of its children are left alone.
            </p>
          </div>
          <div className="max-w-sm">
            <TagInput
              placeholder="Add a rule for tag…"
              onCommit={(raw, suggestion) => {
                const tag = normalize(suggestion ?? raw);
                if (tag && !rules.implications[tag]) setPendingTag(tag);
              }}
            />
          </div>
          {implications.length > 0 ? (
            <ul className="card divide-y divide-line">
              {implications.map(([tag, implied]) => (
                <li key={tag} className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-start">
                  <div className="flex min-w-0 items-center gap-2 sm:w-56 sm:pt-1.5">
                    <span className="min-w-0 truncate font-medium" title={tag}>{tag}</span>
                    <span className="text-fg-subtle">⇒</span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {implied.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {implied.map((t) => (
                          <span key={t} className="chip">
                            {t}
                            <button className="x" aria-label={`Remove ${t} from ${tag}`} onClick={() => setImplied(tag, implied.filter((x) => x !== t))}>
                              <Icon name="close" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <TagInput
                      placeholder="Also add…"
                      autoFocus={tag === pendingTag}
                      onCommit={(raw, suggestion) => {
                        const t = normalize(suggestion ?? raw);
                        if (t && !implied.includes(t)) setImplied(tag, [...implied, t]);
                      }}
                    />
                  </div>
                  <button
                    className="btn ghost sm self-end sm:self-start"
                    aria-label={`Remove rules for ${tag}`}
                    onClick={() => (implied.length ? setImplied(tag, []) : setPendingTag(null))}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-subtle">No implications yet.</p>
          )}
        </section>

        <section className="flex flex-col items-start gap-2 border-t border-line pt-5">
          <h2 className="text-[15px] font-semibold">Existing files</h2>
          <p className="text-xs text-fg-subtle">
            Rules apply to new tagging automatically. To bring older tags in line, rename tags named like an alias to
            its target and add missing implied tags.
          </p>
          <button className="btn" disabled={apply.isPending || (aliases.length === 0 && implications.length === 0)} onClick={() => setConfirmApply(true)}>
            {apply.isPending ? "Applying…" : "Apply to existing files"}
          </button>
        </section>
      </div>

      {confirmApply && (
        <Dialog title="Apply rules to existing files?" onClose={() => setConfirmApply(false)}>
          <p className="text-sm text-fg-muted">
            Tags named like an alias are renamed to its target across the whole library, and implied tags are added to
            every file carrying a rule&apos;s tag. Library files themselves are never changed.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn" onClick={() => setConfirmApply(false)}>Cancel</button>
            <button className="btn primary" onClick={() => { setConfirmApply(false); apply.mutate(); }}>Apply</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
