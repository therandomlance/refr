import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as tags from "refr/server/services/tags";

export const tagsRouter = createTRPCRouter({
  setTags: protectedProcedure
    .input(z.object({ fileIds: z.array(z.string()).min(1), add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) }))
    .mutation(({ input }) => tags.setTags(input.fileIds, input.add, input.remove)),

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
