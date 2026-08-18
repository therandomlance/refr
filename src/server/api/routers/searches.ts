import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as searches from "refr/server/services/searches";
import { tokenSchema } from "refr/server/services/search";

export const searchesRouter = createTRPCRouter({
  list: protectedProcedure.query(() => searches.list()),

  save: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        tokens: z.array(tokenSchema),
        sort: z.enum(["date", "name", "size", "random", "similarity"]).optional(),
      }),
    )
    .mutation(({ input }) => searches.save(input.name, input.tokens, input.sort)),

  delete: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input }) => searches.remove(input.name)),

  rename: protectedProcedure
    .input(z.object({ oldName: z.string(), newName: z.string() }))
    .mutation(({ input }) => searches.rename(input.oldName, input.newName)),
});
