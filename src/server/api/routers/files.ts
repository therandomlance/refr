import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import { executeList, listByOrderedIds, pathPrefixWhere } from "refr/server/services/fileQuery";
import { countExternal, countOrphans, purgeExternal, purgeOrphans } from "refr/server/services/scanner";
import { purgeOrphanThumbs } from "refr/server/services/thumbs";
import * as config from "refr/server/services/config";
import { db } from "refr/server/db";

const sortEnum = z.enum(["date", "name", "size", "random", "similarity"]);

export const filesRouter = createTRPCRouter({
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
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      if (input.ids) {
        return { items: await listByOrderedIds(input.ids), nextCursor: null };
      }
      const recursive = input.recursive ?? true;
      let where: { text: string; params: unknown[] } | undefined;
      if (input.pathPrefix !== undefined) {
        where = pathPrefixWhere(input.pathPrefix, recursive);
      } else if (input.tag !== undefined) {
        const tag = input.tag.replace(/[\\%_]/g, (c) => "\\" + c);
        if (recursive) {
          where = {
            text: `EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
                   WHERE ft.fileId = f.id AND (t.name = ? OR t.name LIKE ? ESCAPE '\\'))`,
            params: [input.tag, tag + "/%"],
          };
        } else {
          where = {
            text: `EXISTS (SELECT 1 FROM FileTag ft JOIN Tag t ON t.id = ft.tagId
                   WHERE ft.fileId = f.id AND t.name = ?)`,
            params: [input.tag],
          };
        }
      }
      return executeList({ where, sort: input.sort, cursor: input.cursor, limit: input.limit });
    }),

  byId: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const file = await db.file.findUnique({
      where: { id: input.id },
      include: { paths: { orderBy: { path: "asc" } } },
    });
    if (!file) throw new TRPCError({ code: "NOT_FOUND" });
    return file;
  }),

  /** §11.7 — copy first existing path into a configured destination. Strict validation. */
  sendTo: protectedProcedure
    .input(z.object({ id: z.string(), destIndex: z.number().int().min(0) }))
    .mutation(async ({ input }) => {
      const dests = config.get().sendToPaths.map((p) => path.resolve(p));
      const dest = dests[input.destIndex];
      if (!dest) throw new TRPCError({ code: "BAD_REQUEST", message: "unknown destination" });
      const file = await db.file.findUnique({
        where: { id: input.id },
        select: { paths: { select: { path: true } } },
      });
      const src = file?.paths.map((p) => p.path).find((p) => fs.existsSync(p));
      if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "no existing path for file" });
      const base = path.basename(src);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      let target = path.join(dest, base);
      for (let i = 1; i <= 999 && fs.existsSync(target); i++) {
        target = path.join(dest, `${stem} (${i})${ext}`);
      }
      if (fs.existsSync(target)) {
        throw new TRPCError({ code: "CONFLICT", message: "too many name collisions" });
      }
      await fsp.mkdir(dest, { recursive: true });
      await fsp.copyFile(src, target);
      return { target };
    }),

  purgeOrphans: protectedProcedure.mutation(() => purgeOrphans()),
  countOrphans: protectedProcedure.query(() => countOrphans()),

  purgeExternal: protectedProcedure.mutation(() => purgeExternal()),
  countExternal: protectedProcedure.query(() => countExternal()),
  purgeOrphanThumbs: protectedProcedure.mutation(() => purgeOrphanThumbs()),
});
