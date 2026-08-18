import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as palettes from "refr/server/services/palettes";

export const palettesRouter = createTRPCRouter({
  list: protectedProcedure.query(() => palettes.list()),

  save: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(1).max(10),
        folder: z.string().default(""),
        sourceFileId: z.string().optional(),
        overwrite: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) =>
      palettes.save({ name: input.name, colors: input.colors, sourceFileId: input.sourceFileId }, input.folder, input.overwrite),
    ),

  createFolder: protectedProcedure
    .input(z.object({ folder: z.string().min(1) }))
    .mutation(({ input }) => palettes.createFolder(input.folder)),

  renameFolder: protectedProcedure
    .input(z.object({ from: z.string().min(1), to: z.string().min(1) }))
    .mutation(({ input }) => palettes.renameFolder(input.from, input.to)),

  deleteFolder: protectedProcedure
    .input(z.object({ folder: z.string().min(1) }))
    .mutation(({ input }) => palettes.deleteFolder(input.folder)),

  delete: protectedProcedure
    .input(z.object({ name: z.string(), folder: z.string().default("") }))
    .mutation(({ input }) => palettes.remove(input.name, input.folder)),

  extract: protectedProcedure
    .input(z.object({ fileId: z.string(), n: z.number().int().min(1).max(10).default(4) }))
    .mutation(({ input }) => palettes.extract(input.fileId, input.n)),

  move: protectedProcedure
    .input(z.object({ name: z.string(), fromFolder: z.string().default(""), toFolder: z.string().default("") }))
    .mutation(({ input }) => palettes.move(input.name, input.fromFolder, input.toFolder)),
});
