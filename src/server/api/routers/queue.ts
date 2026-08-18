import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as queue from "refr/server/services/queue";

const nameSchema = z.string().min(1).max(200);

export const queueRouter = createTRPCRouter({
  get: protectedProcedure.query(() => queue.getQueue()),

  /** One setter for add/remove/reorder — client sends the whole ordered id array. */
  set: protectedProcedure
    .input(z.object({ fileIds: z.array(z.string()) }))
    .mutation(({ input }) => {
      queue.setQueue(input.fileIds);
    }),

  clear: protectedProcedure.mutation(() => queue.clearQueue()),

  save: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) => {
    queue.saveQueue(input.name);
  }),

  listSaved: protectedProcedure.query(() => queue.listSaved()),

  load: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) =>
    queue.loadQueue(input.name),
  ),

  deleteSaved: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) => {
    queue.deleteSaved(input.name);
  }),
});
