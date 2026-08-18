import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as ml from "refr/server/services/ml";

export const mlRouter = createTRPCRouter({
  status: protectedProcedure.query(() => ml.status()),

  setEnabled: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => ml.setEnabled(input.enabled)),

  similar: protectedProcedure
    .input(z.object({ fileId: z.string() }))
    .query(({ input }) => ml.similar(input.fileId)),

  suggestImagesForTag: protectedProcedure
    .input(z.object({ tag: z.string() }))
    .query(({ input }) => ml.suggestImagesForTag(input.tag)),

  suggestTagsForFile: protectedProcedure
    .input(z.object({ fileId: z.string() }))
    .query(({ input }) => ml.suggestTagsForFile(input.fileId)),

  excludeSuggestion: protectedProcedure
    .input(z.object({ tag: z.string(), fileId: z.string() }))
    .mutation(({ input }) => ml.excludeSuggestion(input.tag, input.fileId)),

  reembedAll: protectedProcedure.mutation(() => ml.reembedAll()),
});
