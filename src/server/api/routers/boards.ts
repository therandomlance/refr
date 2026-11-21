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
  resetHidden: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) => boards.resetHidden(input.name)),
  delete: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) => boards.remove(input.name)),
  tree: protectedProcedure.query(() => boards.tree()),
  createFolder: protectedProcedure
    .input(z.object({ name: z.string().min(1), parent: z.string().nullable() }))
    .mutation(({ input }) => boards.createFolder(input.name, input.parent)),
  renameFolder: protectedProcedure
    .input(z.object({ path: z.string().min(1), newName: z.string().min(1) }))
    .mutation(({ input }) => boards.renameFolder(input.path, input.newName)),
  deleteFolder: protectedProcedure
    .input(z.object({ path: z.string().min(1) }))
    .mutation(({ input }) => boards.deleteFolder(input.path)),
  move: protectedProcedure
    .input(z.object({ key: z.string(), parent: z.string().nullable(), beforeKey: z.string().nullable() }))
    .mutation(({ input }) => boards.move(input.key, input.parent, input.beforeKey)),
  addFiles: protectedProcedure
    .input(z.object({ name: nameSchema, fileIds: z.array(z.string()).min(1).max(5000) }))
    .mutation(({ input }) => boards.addFiles(input.name, input.fileIds)),
});
