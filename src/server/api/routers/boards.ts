import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as boards from "refr/server/services/boards";
import { boardSchema } from "refr/lib/boards";

const nameSchema = z.string().min(1).max(200);

export const boardsRouter = createTRPCRouter({
  list: protectedProcedure.query(() => boards.list()),
  get: protectedProcedure.input(z.object({ name: nameSchema })).query(({ input }) => boards.get(input.name)),
  save: protectedProcedure
    .input(z.object({ name: nameSchema, board: boardSchema }))
    .mutation(({ input }) => boards.save(input.name, input.board)),
  create: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) => boards.create(input.name)),
  rename: protectedProcedure
    .input(z.object({ from: nameSchema, to: nameSchema }))
    .mutation(({ input }) => boards.rename(input.from, input.to)),
  delete: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) => boards.remove(input.name)),
  addFiles: protectedProcedure
    .input(z.object({ name: nameSchema, fileIds: z.array(z.string()).min(1).max(5000) }))
    .mutation(({ input }) => boards.addFiles(input.name, input.fileIds)),
});
