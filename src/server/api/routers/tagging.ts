import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as tagging from "refr/server/services/tagging";
import { requestSweep } from "refr/server/services/sweep";
import { BATCH_SIZE } from "refr/lib/tagging";

const confidence = z.number().min(0).max(1);
const ids = z.array(z.string()).max(2000);
const change = z.object({ fileId: z.string(), before: z.array(z.string()), after: z.array(z.string()) });
const denial = z.object({ tag: z.string(), fileId: z.string() });

export const taggingRouter = createTRPCRouter({
  overview: protectedProcedure
    .input(z.object({ minConfidence: confidence }))
    .query(({ input }) => tagging.overview(input.minConfidence)),

  batch: protectedProcedure
    .input(z.object({
      tag: z.string().min(1),
      minConfidence: confidence,
      size: z.number().int().min(1).max(200).default(BATCH_SIZE),
      includeUncertain: z.boolean().default(false),
      exclude: ids.default([]),
    }))
    .query(({ input }) => tagging.batch(input)),

  byFile: protectedProcedure
    .input(z.object({ minConfidence: confidence, cursor: z.string().nullish(), limit: z.number().int().min(1).max(200).default(60) }))
    .query(({ input }) => tagging.byFile({ ...input, cursor: input.cursor ?? null })),

  commit: protectedProcedure
    .input(z.object({
      tag: z.string().min(1),
      accept: ids,
      deny: ids,
      reassign: z.array(z.object({ tag: z.string().min(1), fileIds: ids })).default([]),
    }))
    .mutation(({ input }) => tagging.commit(input)),

  commitFiles: protectedProcedure
    .input(z.array(z.object({ fileId: z.string(), accept: z.array(z.string()), deny: z.array(z.string()) })).max(500))
    .mutation(({ input }) => tagging.commitFiles(input)),

  undo: protectedProcedure
    .input(z.object({ changes: z.array(change), denied: z.array(denial) }))
    .mutation(({ input }) => tagging.undo(input)),

  resweep: protectedProcedure.mutation(() => {
    requestSweep({ full: true });
  }),
});
