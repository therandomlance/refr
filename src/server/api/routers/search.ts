import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as config from "refr/server/services/config";
import { isVectorToken, tokenSchema, tokensToWhere, resolvePathAliases, resolveTagAliases, withVisible, type Token } from "refr/server/services/search";
import { getRules } from "refr/server/services/tagRules";
import { executeList, libraryRootsWhere, timelineBuckets, timelineMonth, timelineMonthSchema } from "refr/server/services/fileQuery";
import { searchTags } from "refr/server/services/tags";
import { semanticSearch, similarSearch, suggestSearch } from "refr/server/services/semantic";

const sortEnum = z.enum(["date", "name", "size", "random", "similarity"]);

/** API-boundary token rewrites: library path aliases, then tag-rule aliases. */
function resolveTokens(tokens: Token[]): Token[] {
  return resolveTagAliases(resolvePathAliases(tokens, config.libraryAliases()), getRules());
}

export const searchRouter = createTRPCRouter({
  /** §9. Tag chips → SQL. A text/similar chip routes through the sidecar (§13.5/§13.6). */
  query: protectedProcedure
    .input(
      z.object({
        tokens: z.array(tokenSchema).refine(
          (tokens) => tokens.filter(isVectorToken).length <= 1,
          "Only one semantic search chip is allowed",
        ),
        sort: sortEnum.default("date"),
        cursor: z.string().nullish(),
        // timeline scrubber seek: used only for the first page (when no page cursor yet)
        seek: z.string().nullish(),
        month: timelineMonthSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      const cursor = input.cursor ?? input.seek;
      const tokens = resolveTokens(input.tokens);
      const textChip = tokens.find((t) => t.kind === "text");
      const similarChip = tokens.find((t) => t.kind === "similar");
      const suggestChip = tokens.find(
        (t) => t.kind === "tag" && t.tag.startsWith("suggest:"),
      );
      const tagChips = tokens.filter(
        (t) => t.kind === "tag" && !t.tag.startsWith("suggest:"),
      );
      if (textChip) {
        return semanticSearch(textChip, tagChips, input.cursor, input.limit ?? 200);
      }
      if (similarChip) {
        return similarSearch(similarChip.tag, tagChips, input.cursor, input.limit ?? 200);
      }
      if (suggestChip) {
        return suggestSearch(
          suggestChip.tag.slice("suggest:".length),
          tagChips,
          input.cursor,
          input.limit ?? 200,
        );
      }
      const where = tokens.length === 0
        ? withVisible(libraryRootsWhere(config.timelineRoots()))
        : tokensToWhere(tokens);
      if (input.month) return timelineMonth(where, input.month);
      return executeList({ where, sort: input.sort, cursor, limit: input.limit });
    }),

  /** Month buckets for the timeline scrubber, scoped to the same tokens as `query`. */
  timeline: protectedProcedure
    .input(z.object({ tokens: z.array(tokenSchema) }))
    .query(({ input }) =>
      timelineBuckets(
        tokensToWhere(resolveTokens(input.tokens)),
        input.tokens.length === 0 ? config.timelineRoots() : undefined,
      ),
    ),

  autocomplete: protectedProcedure
    .input(z.object({ term: z.string() }))
    .query(({ input }) => searchTags(input.term)),
});
