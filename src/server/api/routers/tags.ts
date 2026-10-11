import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as tags from "refr/server/services/tags";

const tagNames = z.array(z.string().min(1).refine((name) => name === tags.normalize(name), "Tag names must be normalized"))
  .refine((names) => new Set(names).size === names.length, "Duplicate tags are not allowed");
const undoChanges = z.array(z.object({ fileId: z.string(), before: tagNames, after: tagNames })).min(1)
  .refine((changes) => new Set(changes.map((change) => change.fileId)).size === changes.length, "Duplicate files are not allowed");

export const tagsRouter = createTRPCRouter({
  setTags: protectedProcedure
    .input(z.object({ fileIds: z.array(z.string()).min(1), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }))
    .mutation(({ input }) => tags.setTags(input.fileIds, input.add, input.remove)),

  undo: protectedProcedure
    .input(z.object({ changes: undoChanges }))
    .mutation(async ({ input }) => {
      try { await tags.undoTags(input.changes); }
      catch (error) {
        if (error instanceof tags.TagUndoConflict) throw new TRPCError({ code: "CONFLICT", message: error.message });
        throw error;
      }
    }),

  rename: protectedProcedure
    .input(z.object({ oldName: z.string(), newName: z.string() }))
    .mutation(({ input }) => tags.rename(input.oldName, input.newName)),

  merge: protectedProcedure
    .input(z.object({ sources: z.array(z.string()).min(1), target: z.string() }))
    .mutation(({ input }) => tags.merge(input.sources, input.target)),

  delete: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input }) => tags.deleteTag(input.name)),

  tree: protectedProcedure.query(() => tags.tree()),

  search: protectedProcedure
    .input(z.object({ term: z.string(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(({ input }) => tags.searchTags(input.term, input.limit)),

  forFiles: protectedProcedure
    .input(z.object({ fileIds: z.array(z.string()).min(1) }))
    .query(({ input }) => tags.forFiles(input.fileIds)),
});
