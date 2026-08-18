import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as config from "refr/server/services/config";
import * as auth from "refr/server/services/auth";
import { scanNow, scanStatus } from "refr/server/services/scanner";
import { thumbStatus } from "refr/server/services/thumbs";

export const settingsRouter = createTRPCRouter({
  get: protectedProcedure.query(() => {
    const { passwordHash, ...rest } = config.get();
    return { ...rest, hasPassword: passwordHash !== null };
  }),

  patch: protectedProcedure
    .input(
      z
        .object({
          libraries: z.array(z.string()),
          scanTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
          defaultThumbnailSize: z.enum(["small", "medium", "large"]),
          skipTagRemoveConfirm: z.boolean(),
          sendToPaths: z.array(z.string()),
          sessionHistoryCap: z.number().int().min(1),
          theme: z.enum(config.THEMES),
          ml: z
            .object({
              port: z.number().int(),
              model: z.string(),
              pretrained: z.string(),
              tagSuggestionTextWeight: z.number().min(0).max(1),
              tagSuggestionMinScore: z.number(),
            })
            .partial(),
        })
        .partial(),
    )
    .mutation(({ input }) => {
      config.patch(input);
      const { passwordHash, ...rest } = config.get();
      return { ...rest, hasPassword: passwordHash !== null };
    }),

  scanNow: protectedProcedure.mutation(() => {
    void scanNow();
    return scanStatus();
  }),

  scanStatus: protectedProcedure.query(() => scanStatus()),

  thumbStatus: protectedProcedure.query(() => thumbStatus()),

  setPassword: protectedProcedure
    .input(z.object({ current: z.string().optional(), next: z.string().min(1) }))
    .mutation(({ input }) => {
      if (!auth.isOpen() && !auth.verifyPassword(input.current ?? "")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "current password incorrect" });
      }
      auth.setPassword(input.next);
    }),

  clearPassword: protectedProcedure
    .input(z.object({ current: z.string().optional() }))
    .mutation(({ input }) => {
      if (!auth.isOpen() && !auth.verifyPassword(input.current ?? "")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "current password incorrect" });
      }
      auth.clearPassword();
    }),
});
