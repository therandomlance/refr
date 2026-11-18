"use client";

import { api, type RouterOutputs } from "refr/trpc/react";
import { useActionFeedback } from "refr/app/_components/action-feedback";

type CommitResult = RouterOutputs["tagging"]["commit"];

/** Batch commit + one-click undo (tags and ✕ denials together), refreshing every
 *  view that shows tags or suggestions. */
export function useReviewCommit() {
  const notify = useActionFeedback();
  const utils = api.useUtils();
  const commit = api.tagging.commit.useMutation({ meta: { customFeedback: true } });
  const commitFiles = api.tagging.commitFiles.useMutation({ meta: { customFeedback: true } });
  const undo = api.tagging.undo.useMutation({ meta: { customFeedback: true } });

  const refresh = () => {
    void utils.tagging.invalidate();
    void utils.tags.invalidate();
    void utils.browse.tagTree.invalidate();
    void utils.files.invalidate();
    void utils.search.invalidate();
    void utils.ml.invalidate();
  };

  const report = (result: CommitResult) => {
    refresh();
    const tagged = result.changes.length;
    const rejected = result.denied.length;
    const parts = [tagged && `${tagged} tagged`, rejected && `${rejected} rejected`].filter(Boolean);
    notify({
      message: parts.length ? `${parts.join(", ")}.` : "Nothing to change.",
      undo: parts.length ? async () => {
        await undo.mutateAsync(result);
        refresh();
      } : undefined,
    });
    return result;
  };

  return {
    isPending: commit.isPending || commitFiles.isPending || undo.isPending,
    commitTag: async (input: Parameters<typeof commit.mutateAsync>[0]) => report(await commit.mutateAsync(input)),
    commitFiles: async (input: Parameters<typeof commitFiles.mutateAsync>[0]) => report(await commitFiles.mutateAsync(input)),
  };
}
