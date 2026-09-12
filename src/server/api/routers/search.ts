import path from "node:path";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import * as config from "refr/server/services/config";
import { tokenSchema, tokensToWhere, resolvePathAliases } from "refr/server/services/search";
import { executeList, timelineBuckets } from "refr/server/services/fileQuery";
import { searchTags } from "refr/server/services/tags";
import { semanticSearch, similarSearch, suggestSearch } from "refr/server/services/semantic";

const sortEnum = z.enum(["date", "name", "size", "random", "similarity"]);

/** Library aliases → resolved root, lowercased keys: `path:<alias>` lookup. */
function libraryAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of config.get().libraries) {
    if (l.alias) out[l.alias.toLowerCase()] = path.resolve(l.path);
  }
  return out;
}

export const searchRouter = createTRPCRouter({
  /** §9. Tag chips → SQL. A text/similar chip routes through the sidecar (§13.5/§13.6). */
  query: protectedProcedure
    .input(
      z.object({
        tokens: z.array(tokenSchema),
        sort: sortEnum.default("date"),
        cursor: z.string().nullish(),
        // timeline scrubber seek: used only for the first page (when no page cursor yet)
        seek: z.string().nullish(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      const cursor = input.cursor ?? input.seek;
      const tokens = resolvePathAliases(input.tokens, libraryAliases());
      const textChip = tokens.find((t) => t.kind === "text");
      const similarChip = tokens.find((t) => t.kind === "similar");
      const suggestChip = tokens.find(
        (t) => t.kind === "tag" && t.tag.startsWith("suggest:"),
      );
      const tagChips = tokens.filter(
        (t) => t.kind === "tag" && !t.tag.startsWith("suggest:"),
      );
      if (textChip) {
        return semanticSearch(textChip, tagChips, cursor, input.limit ?? 200);
      }
      if (similarChip) {
        return similarSearch(similarChip.tag, tagChips, cursor, input.limit ?? 200);
      }
      if (suggestChip) {
        return suggestSearch(
          suggestChip.tag.slice("suggest:".length),
          tagChips,
          cursor,
          input.limit ?? 200,
        );
      }
      const where = tokensToWhere(tokens);
      return executeList({ where, sort: input.sort, cursor, limit: input.limit });
    }),

  /** Month buckets for the timeline scrubber, scoped to the same tokens as `query`. */
  timeline: protectedProcedure
    .input(z.object({ tokens: z.array(tokenSchema) }))
    .query(({ input }) =>
      timelineBuckets(
        tokensToWhere(resolvePathAliases(input.tokens, libraryAliases())),
        config.timelineRoots(),
      ),
    ),

  autocomplete: protectedProcedure
    .input(z.object({ term: z.string() }))
    .query(({ input }) => searchTags(input.term)),
});
