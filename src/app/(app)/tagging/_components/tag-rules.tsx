"use client";

import { useRef, useState } from "react";
import { api } from "refr/trpc/react";
import { Dialog } from "refr/app/_components/dialog";
import { Icon } from "refr/app/_components/icon";
import { Hint } from "refr/app/_components/hint";
import { TagInput } from "refr/app/_components/tag-input";
import { useActionFeedback } from "refr/app/_components/action-feedback";
import { normalize } from "refr/lib/tag-names";
import { EMPTY_RULES, sanitizeRules, validateRules, type TagRules } from "refr/lib/tag-rules";

type Section = "aliases" | "implications" | "timeline";

/**
 * Tagging → Rules: tag aliases (`fig → reference/figure`) and implications
 * (`artist/x ⇒ medium/digital`), plus tags hidden from the main timeline. Each section adds a rule from one "A → B"
 * form; edits are validated with the same pure functions the server uses,
 * then saved straight to data/tag-rules.json. Removals offer undo.
 */
export function TagRulesEditor() {
  const utils = api.useUtils();
  const notify = useActionFeedback();
  const rulesQ = api.tagRules.get.useQuery();
  const save = api.tagRules.save.useMutation({
    meta: { customFeedback: true },
    onSuccess: (rules) => {
      utils.tagRules.get.setData(undefined, rules);
      // timeline-hidden tags change what the main timeline shows
      void utils.files.invalidate();
      void utils.search.invalidate();
    },
  });
  const apply = api.tagRules.applyToExisting.useMutation({
    meta: { customFeedback: true },
    onSuccess: ({ renamedTags, changedFiles }) => {
      setUnapplied(false);
      void utils.invalidate();
      notify({
        message: renamedTags || changedFiles
          ? `Renamed ${renamedTags} tag${renamedTags === 1 ? "" : "s"}, updated ${changedFiles} file${changedFiles === 1 ? "" : "s"}.`
          : "Everything already follows the rules.",
      });
    },
  });
  const [problems, setProblems] = useState<{ section: Section; list: string[] } | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  // a rule was added this visit; existing files don't follow it until applied
  const [unapplied, setUnapplied] = useState(false);
  // implication row whose "add another" input is open
  const [extending, setExtending] = useState<string | null>(null);

  const rules = rulesQ.data ?? EMPTY_RULES;

  /** Validate + save. Returns false (and shows why under `section`) when invalid. */
  const commit = (next: TagRules, section: Section): boolean => {
    const clean = sanitizeRules(next);
    const errors = validateRules(clean);
    setProblems(errors.length ? { section, list: errors } : null);
    if (errors.length) return false;
    save.mutate(clean, { onError: (e) => setProblems({ section, list: e.message.split("\n") }) });
    return true;
  };

  const remove = (next: TagRules, section: Section, message: string) => {
    const before = rules;
    if (commit(next, section)) notify({ message, undo: async () => { await save.mutateAsync(before); } });
  };

  const added = (ok: boolean) => {
    if (ok) setUnapplied(true);
    return ok;
  };

  const aliases = Object.entries(rules.aliases).sort(([a], [b]) => a.localeCompare(b));
  const implications = Object.entries(rules.implications).sort(([a], [b]) => a.localeCompare(b));

  const setImplied = (tag: string, implied: string[]) => {
    const next = { ...rules.implications, [tag]: implied };
    if (implied.length === 0) delete next[tag];
    return commit({ ...rules, implications: next }, "implications");
  };

  if (!rulesQ.data) return <p className="px-5 py-4 text-sm text-fg-subtle">Loading…</p>;

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
      <div className="flex max-w-3xl flex-col gap-8">
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">
              Aliases
              <Hint text="A shorthand also works as a prefix: fig/arms becomes reference/figure/arms if fig is an alias for reference/figure." />
            </h2>
            <p className="text-xs text-fg-muted">Type a shorthand while tagging or searching and it&apos;s swapped for the full tag.</p>
          </div>
          <PairForm
            leftIsTag={false}
            leftPlaceholder="Shorthand, e.g. fig"
            rightPlaceholder="Full tag…"
            arrow="→"
            submitLabel="Add alias"
            problems={problems?.section === "aliases" ? problems.list : []}
            onAdd={(from, to) => added(commit({ ...rules, aliases: { ...rules.aliases, [from]: to } }, "aliases"))}
          />
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
                    title="Remove alias"
                    onClick={() => {
                      const next = { ...rules.aliases };
                      delete next[from];
                      remove({ ...rules, aliases: next }, "aliases", `Removed alias ${from}.`);
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
            <h2 className="text-[15px] font-semibold">
              Implications
              <Hint text="A rule also covers tags beneath it, and implied tags pull in their own implications. Files that already carry an implied tag or one of its children are left alone." />
            </h2>
            <p className="text-xs text-fg-muted">When a file gets the first tag, it also gets the second.</p>
          </div>
          <PairForm
            leftIsTag
            leftPlaceholder="When tagged…"
            rightPlaceholder="Also add…"
            arrow="⇒"
            submitLabel="Add rule"
            problems={problems?.section === "implications" ? problems.list : []}
            onAdd={(tag, also) => {
              const current = rules.implications[tag] ?? [];
              return added(current.includes(also) || setImplied(tag, [...current, also]));
            }}
          />
          {implications.length > 0 ? (
            <ul className="card divide-y divide-line">
              {implications.map(([tag, implied]) => (
                <li key={tag} className="flex items-start gap-2 px-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2 pt-1 sm:w-56 sm:shrink-0">
                    <span className="min-w-0 truncate font-medium" title={tag}>{tag}</span>
                    <span className="text-fg-subtle">⇒</span>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    {implied.map((t) => (
                      <span key={t} className="chip">
                        {t}
                        <button
                          className="x"
                          aria-label={`Remove ${t} from ${tag}`}
                          onClick={() => {
                            const next = { ...rules.implications, [tag]: implied.filter((x) => x !== t) };
                            if (next[tag]!.length === 0) delete next[tag];
                            remove({ ...rules, implications: next }, "implications", `${tag} no longer adds ${t}.`);
                          }}
                        >
                          <Icon name="close" />
                        </button>
                      </span>
                    ))}
                    {extending === tag ? (
                      <div className="flex min-w-48 flex-1 items-center gap-1">
                        <div className="flex-1">
                          <TagInput
                            autoFocus
                            placeholder="Also add…"
                            onCommit={(raw, suggestion) => {
                              const t = normalize(suggestion ?? raw);
                              if (t && !implied.includes(t)) added(setImplied(tag, [...implied, t]));
                            }}
                          />
                        </div>
                        <button className="btn ghost sm" onClick={() => setExtending(null)}>Done</button>
                      </div>
                    ) : (
                      <button
                        className="btn ghost sm"
                        aria-label={`Add another tag to ${tag}`}
                        title="Add another tag"
                        onClick={() => setExtending(tag)}
                      >
                        <Icon name="plus" />
                      </button>
                    )}
                  </div>
                  <button
                    className="btn ghost sm"
                    aria-label={`Remove rules for ${tag}`}
                    title="Remove rule"
                    onClick={() => {
                      const next = { ...rules.implications };
                      delete next[tag];
                      remove({ ...rules, implications: next }, "implications", `Removed rule for ${tag}.`);
                    }}
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

        <section className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold">
            Hidden from timeline
            <Hint text="Works like turning off a library's timeline: the files are still indexed and turn up in search, tag and folder views. Tags beneath a hidden tag are hidden too." />
          </h2>
          <div className="flex flex-col gap-2">
            <div className="max-w-sm">
              <TagInput
                placeholder="Hide tag…"
                onCommit={(raw, suggestion) => {
                  const t = normalize(suggestion ?? raw);
                  if (t && !rules.timelineHidden.includes(t)) commit({ ...rules, timelineHidden: [...rules.timelineHidden, t] }, "timeline");
                }}
              />
            </div>
            {problems?.section === "timeline" && (
              <div role="alert" className="text-xs text-danger">
                {problems.list.map((p) => <p key={p}>{p}</p>)}
              </div>
            )}
          </div>
          {rules.timelineHidden.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {rules.timelineHidden.map((t) => (
                <span key={t} className="chip">
                  {t}
                  <button
                    className="x"
                    aria-label={`Show ${t} in the timeline again`}
                    onClick={() => remove(
                      { ...rules, timelineHidden: rules.timelineHidden.filter((x) => x !== t) },
                      "timeline",
                      `${t} shows in the timeline again.`,
                    )}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-fg-subtle">No hidden tags.</p>
          )}
        </section>

        <section className="flex flex-col items-start gap-2 border-t border-line pt-5">
          <h2 className="text-[15px] font-semibold">Existing files</h2>
          <p className="text-xs text-fg-muted">
            {unapplied
              ? "Your new aliases and implications only affect tags added from now on. Apply them to bring files tagged earlier in line."
              : "Aliases and implications apply automatically whenever tags are added. Files tagged before a rule existed change only when you apply the rules."}
          </p>
          <button
            className={`btn ${unapplied ? "primary" : ""}`}
            disabled={apply.isPending || (aliases.length === 0 && implications.length === 0)}
            onClick={() => setConfirmApply(true)}
          >
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

/**
 * "A → B [Add]" in one row. Enter in the first field moves to the second;
 * Enter (or picking a suggestion) in the second adds the rule. Fields keep
 * their text when the rule is rejected so it can be fixed in place.
 */
function PairForm({
  leftIsTag,
  leftPlaceholder,
  rightPlaceholder,
  arrow,
  submitLabel,
  problems,
  onAdd,
}: {
  leftIsTag: boolean;
  leftPlaceholder: string;
  rightPlaceholder: string;
  arrow: string;
  submitLabel: string;
  problems: string[];
  /** normalized, non-empty values; return true when saved (the form then clears) */
  onAdd: (left: string, right: string) => boolean;
}) {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  // bumped to remount (and so clear) the TagInputs after a successful add
  const [generation, setGeneration] = useState(0);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const focus = (box: React.RefObject<HTMLDivElement | null>) => box.current?.querySelector("input")?.focus();

  const submit = (l = left, r = right) => {
    const a = normalize(l);
    const b = normalize(r);
    if (!a) return focus(leftRef);
    if (!b) return focus(rightRef);
    if (!onAdd(a, b)) return;
    setLeft("");
    setRight("");
    setGeneration((g) => g + 1);
    requestAnimationFrame(() => focus(leftRef));
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div ref={leftRef} className="w-52">
          {leftIsTag ? (
            <TagInput
              key={`l${generation}`}
              keepOnCommit
              placeholder={leftPlaceholder}
              onRawChange={setLeft}
              onCommit={(raw, suggestion) => {
                const v = suggestion ?? raw;
                setLeft(v);
                if (normalize(right)) submit(v, right);
                else focus(rightRef);
              }}
            />
          ) : (
            <input
              className="input w-full"
              placeholder={leftPlaceholder}
              aria-label={leftPlaceholder}
              value={left}
              onChange={(e) => setLeft(e.target.value)}
            />
          )}
        </div>
        <span className="text-fg-subtle">{arrow}</span>
        <div ref={rightRef} className="min-w-52 flex-1">
          <TagInput
            key={`r${generation}`}
            keepOnCommit
            placeholder={rightPlaceholder}
            onRawChange={setRight}
            onCommit={(raw, suggestion) => {
              const v = suggestion ?? raw;
              setRight(v);
              submit(left, v);
            }}
          />
        </div>
        <button type="submit" className="btn" disabled={!left.trim() || !right.trim()}>{submitLabel}</button>
      </form>
      {problems.length > 0 && (
        <div role="alert" className="text-xs text-danger">
          {problems.map((p) => <p key={p}>{p}</p>)}
        </div>
      )}
    </div>
  );
}
