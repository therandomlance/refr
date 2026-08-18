import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import { tokenSchema, tokensToWhere } from "refr/server/services/search";
import { executeList } from "refr/server/services/fileQuery";
import { searchTags } from "refr/server/services/tags";
import { semanticSearch, similarSearch } from "refr/server/services/semantic";

const sortEnum = z.enum(["date", "name", "size", "random", "similarity"]);

export const searchRouter = createTRPCRouter({
  /** §9. Tag chips → SQL. A text/similar chip routes through the sidecar (§13.5/§13.6). */
  query: protectedProcedure
    .input(
      z.object({
        tokens: z.array(tokenSchema),
        sort: sortEnum.default("date"),
        cursor: z.string().nullish(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      const textChip = input.tokens.find((t) => t.kind === "text");
      const similarChip = input.tokens.find((t) => t.kind === "similar");
      const tagChips = input.tokens.filter((t) => t.kind === "tag");
      if (textChip) {
        return semanticSearch(textChip, tagChips, input.cursor, input.limit ?? 200);
      }
      if (similarChip) {
        return similarSearch(similarChip.tag, tagChips, input.cursor, input.limit ?? 200);
      }
      const where = tokensToWhere(input.tokens);
      return executeList({ where, sort: input.sort, cursor: input.cursor, limit: input.limit });
    }),

  autocomplete: protectedProcedure
    .input(z.object({ term: z.string() }))
    .query(({ input }) => searchTags(input.term)),
});
