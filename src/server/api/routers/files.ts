import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import { executeList, listByOrderedIds, mainTimelineWhere, sourceWhere, timelineBuckets, timelineMonth, timelineMonthSchema } from "refr/server/services/fileQuery";
import { withVisible } from "refr/server/services/search";
import { setFavorite, setMeta } from "refr/server/services/fileMeta";
import { countExternal, countOrphans, purgeExternal, purgeOrphans } from "refr/server/services/scanner";
import { purgeOrphanThumbs } from "refr/server/services/thumbs";
import * as config from "refr/server/services/config";
import { pathComplete } from "refr/server/services/pathComplete";
import { db } from "refr/server/db";

const sortEnum = z.enum(["date", "name", "size", "random", "similarity"]);

export const filesRouter = createTRPCRouter({
  /** IDs only for browse selection; independent of the grid's loaded pages/sort. */
  ids: protectedProcedure
    .input(z.object({
      pathPrefix: z.string().optional(),
      tag: z.string().optional(),
      recursive: z.boolean().optional(),
      cursor: z.string().nullish(),
      limit: z.number().int().min(1).max(1000).default(1000),
    }))
    .query(async ({ input }) => {
      const where = withVisible(sourceWhere(input) ?? mainTimelineWhere());
      const rows = await db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT f.id FROM File f WHERE (${where?.text ?? "1=1"}) AND f.id > ?
         ORDER BY f.id ASC LIMIT ?`,
        ...(where?.params ?? []), input.cursor ?? "", input.limit + 1,
      );
      const ids = rows.slice(0, input.limit).map((r) => r.id);
      return { ids, nextCursor: rows.length > input.limit ? ids.at(-1)! : null };
    }),

  /** Shared cursor query (§9.4). Filter by path prefix, tag, or explicit ids. */
  list: protectedProcedure
    .input(
      z.object({
        pathPrefix: z.string().optional(),
        tag: z.string().optional(),
        ids: z.array(z.string()).optional(), // explicit ids mode (queue/similar): order preserved, no pagination
        recursive: z.boolean().optional(), // include files in subfolders/subtags (default true)
        sort: sortEnum.default("date"),
        cursor: z.string().nullish(),
        // timeline scrubber seek: used only for the first page (when no page cursor yet)
        seek: z.string().nullish(),
        month: timelineMonthSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      if (input.ids) {
        return { items: await listByOrderedIds(input.ids), nextCursor: null, prevCursor: null };
      }
      const where = withVisible(sourceWhere({
        pathPrefix: input.pathPrefix,
        tag: input.tag,
        recursive: input.recursive,
      }) ?? mainTimelineWhere());
      if (input.month) return timelineMonth(where, input.month);
      return executeList({
        where,
        sort: input.sort,
        cursor: input.cursor ?? input.seek,
        limit: input.limit,
      });
    }),

  /** Month buckets for the timeline scrubber, scoped to the same filters as `list`. */
  timeline: protectedProcedure
    .input(
      z.object({
        pathPrefix: z.string().optional(),
        tag: z.string().optional(),
        recursive: z.boolean().optional(),
      }),
    )
    .query(({ input }) => timelineBuckets(
      withVisible(sourceWhere(input) ?? mainTimelineWhere()),
    )),

  byId: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const file = await db.file.findUnique({
      where: { id: input.id },
      include: {
        paths: { orderBy: { path: "asc" } },
        meta: { select: { favorite: true, duplicateOf: true, source: true, note: true, takenAt: true, camera: true } },
      },
    });
    if (!file) throw new TRPCError({ code: "NOT_FOUND" });
    return file;
  }),

  setMeta: protectedProcedure
    .input(z.object({ fileId: z.string(), source: z.string().max(2000).optional(), note: z.string().max(20_000).optional() }))
    .mutation(({ input }) => setMeta(input.fileId, input)),

  setFavorite: protectedProcedure
    .input(z.object({ fileIds: z.array(z.string()).min(1), favorite: z.boolean().optional() }))
    .mutation(({ input }) => setFavorite(input.fileIds, input.favorite)),

  /** §11.7 — copy every selected file without overwriting existing filenames. */
  sendTo: protectedProcedure
    .input(z.object({ fileIds: z.array(z.string().min(1)).min(1), destIndex: z.number().int().min(0) }))
    .mutation(async ({ input }) => {
      const destination = config.get().sendToPaths[input.destIndex];
      if (!destination) throw new TRPCError({ code: "BAD_REQUEST", message: "unknown destination" });
      const dest = path.resolve(destination.path);
      await fsp.mkdir(dest, { recursive: true });
      const copied: string[] = [];
      const existing: string[] = [];
      const failed: { id: string; name: string; message: string }[] = [];
      for (const id of new Set(input.fileIds)) {
        const file = await db.file.findUnique({
          where: { id },
          select: { paths: { select: { path: true }, orderBy: { path: "asc" } } },
        });
        const src = file?.paths.map((p) => p.path).find((p) => fs.existsSync(p));
        if (!src) {
          failed.push({ id, name: path.basename(file?.paths[0]?.path ?? id), message: "no existing path for file" });
          continue;
        }
        const name = path.basename(src);
        try {
          // Atomic filename check: concurrent sends must never overwrite each other.
          await fsp.copyFile(src, path.join(dest, name), fs.constants.COPYFILE_EXCL);
          copied.push(name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") existing.push(name);
          else failed.push({ id, name, message: error instanceof Error ? error.message : "copy failed" });
        }
      }
      return { copied, existing, failed };
    }),

  purgeOrphans: protectedProcedure.mutation(() => purgeOrphans()),
  countOrphans: protectedProcedure.query(() => countOrphans()),

  purgeExternal: protectedProcedure.mutation(() => purgeExternal()),
  countExternal: protectedProcedure.query(() => countExternal()),
  purgeOrphanThumbs: protectedProcedure.mutation(() => purgeOrphanThumbs()),

  pathComplete: protectedProcedure
    .input(z.object({ typed: z.string() }))
    .query(({ input }) =>
      pathComplete(
        input.typed,
        config.get().libraries.map((l) => ({ root: path.resolve(l.path), ...(l.alias ? { alias: l.alias } : {}) })),
      ),
    ),
});
