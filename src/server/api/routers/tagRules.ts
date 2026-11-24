import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import { getRules, saveRules, TagRulesInvalid } from "refr/server/services/tagRules";
import { applyRulesToExisting } from "refr/server/services/tags";

const rulesInput = z.object({
  aliases: z.record(z.string(), z.string()),
  implications: z.record(z.string(), z.array(z.string())),
});

/** Tag aliases + implications (data/tag-rules.json), edited on Tagging → Rules. */
export const tagRulesRouter = createTRPCRouter({
  get: protectedProcedure.query(() => getRules()),

  save: protectedProcedure.input(rulesInput).mutation(({ input }) => {
    try {
      return saveRules(input);
    } catch (error) {
      if (error instanceof TagRulesInvalid) throw new TRPCError({ code: "BAD_REQUEST", message: error.problems.join("\n") });
      throw error;
    }
  }),

  applyToExisting: protectedProcedure.mutation(() => applyRulesToExisting()),
});
