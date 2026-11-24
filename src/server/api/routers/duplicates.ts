import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import { catchUpDhash, dismissPair, listPairs, resolvePair, unhide } from "refr/server/services/duplicates";

/** Near-duplicate review (Tagging → Duplicates). */
export const duplicatesRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ fileId: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) }))
    .query(({ input }) => listPairs(input)),

  resolve: protectedProcedure
    .input(z.object({ keeper: z.string(), copy: z.string() }))
    .mutation(({ input }) => resolvePair(input.keeper, input.copy)),

  dismiss: protectedProcedure
    .input(z.object({ a: z.string(), b: z.string() }))
    .mutation(({ input }) => dismissPair(input.a, input.b)),

  unhide: protectedProcedure
    .input(z.object({ fileId: z.string() }))
    .mutation(({ input }) => unhide(input.fileId)),

  /** Start (or join) the background hashing pass. */
  rehash: protectedProcedure.mutation(() => {
    void catchUpDhash();
  }),
});
