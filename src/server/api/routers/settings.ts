import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as config from "refr/server/services/config";
import * as auth from "refr/server/services/auth";
import { scanNow, scanStatus } from "refr/server/services/scanner";
import { thumbStatus } from "refr/server/services/thumbs";
import { listSnapshots, snapshotDb } from "refr/server/services/backup";
import { enqueueTagVectors } from "refr/server/services/ml";

export const settingsRouter = createTRPCRouter({
  get: protectedProcedure.query(() => {
    const { passwordHash, ...rest } = config.get();
    return { ...rest, hasPassword: passwordHash !== null };
  }),

  patch: protectedProcedure
    .input(
      z
        .object({
          libraries: z.array(
            z.object({
              path: z.string(),
              alias: z.string().optional(),
            }),
          ),
          timelineExclude: z.object({ paths: z.array(z.string()), tags: z.array(z.string()) }).partial(),
          scanTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
          defaultThumbnailSize: z.enum(["small", "medium", "large"]),
          skipTagRemoveConfirm: z.boolean(),
          sendToPaths: config.sendToPathsSchema,
          sessionHistoryCap: z.number().int().min(1),
          theme: z.enum(config.THEMES),
          accent: z.enum(config.ACCENTS),
          density: z.enum(config.DENSITIES),
          backup: z.object({ enabled: z.boolean(), keep: z.number().int().min(1).max(100) }).partial(),
          ml: z
            .object({
              port: z.number().int(),
              model: z.string(),
              pretrained: z.string(),
              tagSuggestionTextWeight: z.number().min(0).max(1),
              tagModel: z.enum(["auto", "vector"]),
            })
            .partial(),
        })
        .partial(),
    )
    .mutation(({ input }) => {
      config.patch(input);
      // a text-weight change makes tag vectors stale; enabling classifiers needs them trained
      if (input.ml?.tagSuggestionTextWeight !== undefined || input.ml?.tagModel === "auto") void enqueueTagVectors();
      const { passwordHash, ...rest } = config.get();
      return { ...rest, hasPassword: passwordHash !== null };
    }),

  scanNow: protectedProcedure.mutation(() => {
    void scanNow();
    return scanStatus();
  }),

  scanStatus: protectedProcedure.query(() => scanStatus()),

  snapshots: protectedProcedure.query(() => listSnapshots()),
  backupNow: protectedProcedure.mutation(() => snapshotDb()),

  thumbStatus: protectedProcedure.query(() => thumbStatus()),

  setPassword: protectedProcedure
    .input(z.object({ current: z.string().optional(), next: z.string().min(1) }))
    .mutation(async ({ input }) => {
      if (!auth.isOpen() && !(await auth.verifyPassword(input.current ?? ""))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "current password incorrect" });
      }
      await auth.setPassword(input.next);
    }),

  clearPassword: protectedProcedure
    .input(z.object({ current: z.string().optional() }))
    .mutation(async ({ input }) => {
      if (!auth.isOpen() && !(await auth.verifyPassword(input.current ?? ""))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "current password incorrect" });
      }
      auth.clearPassword();
    }),
});
