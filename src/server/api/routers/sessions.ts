import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as sessions from "refr/server/services/sessions";
import { blockSchema } from "refr/server/services/sessions";

const nameSchema = z.string().min(1).max(200);

export const sessionsRouter = createTRPCRouter({
  list: protectedProcedure.query(() => sessions.listTemplates()),

  get: protectedProcedure.input(z.object({ name: nameSchema })).query(({ input }) =>
    sessions.getTemplate(input.name),
  ),

  save: protectedProcedure
    .input(z.object({ name: nameSchema, blocks: z.array(blockSchema), avoidRecent: z.number().int().min(0).max(1000).default(0) }))
    .mutation(({ input }) => {
      sessions.saveTemplate({ name: input.name, blocks: input.blocks, avoidRecent: input.avoidRecent });
    }),

  delete: protectedProcedure.input(z.object({ name: nameSchema })).mutation(({ input }) => {
    sessions.deleteTemplate(input.name);
  }),

  renameTemplate: protectedProcedure
    .input(z.object({ oldName: nameSchema, newName: nameSchema }))
    .mutation(({ input }) => sessions.renameTemplate(input.oldName, input.newName)),

  generate: protectedProcedure
    .input(z.object({ name: nameSchema }))
    .mutation(({ input }) => sessions.generate(input.name)),

  history: protectedProcedure.input(z.object({ name: nameSchema })).query(({ input }) =>
    sessions.getHistory(input.name),
  ),

  finish: protectedProcedure
    .input(z.object({ name: nameSchema, date: z.string(), elapsedSeconds: z.number().min(0).max(86_400), viewed: z.number().int().min(0) }))
    .mutation(({ input }) => sessions.finish(input.name, input.date, input)),

  stats: protectedProcedure.query(() => sessions.stats()),

  replay: protectedProcedure
    .input(z.object({ name: nameSchema, historyIndex: z.number().int().min(0) }))
    .query(({ input }) => sessions.replay(input.name, input.historyIndex)),
});
