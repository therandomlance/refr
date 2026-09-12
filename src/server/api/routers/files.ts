import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "refr/server/api/trpc";
import { executeList, listByOrderedIds, sourceWhere, timelineBuckets } from "refr/server/services/fileQuery";
import { countExternal, countOrphans, purgeExternal, purgeOrphans } from "refr/server/services/scanner";
import { purgeOrphanThumbs } from "refr/server/services/thumbs";
import * as config from "refr/server/services/config";
import { db } from "refr/server/db";

const sortEnum = z.enum(["date", "name", "size", "random", "similarity"]);

/** Directory names in `dir` whose name starts with `partial`. */
async function dirSuggestions(dir: string, partial: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(partial.toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Split a full path into its existing parent dir + trailing partial segment. */
async function resolveDir(full: string): Promise<{ dir: string; partial: string }> {
  try {
    const st = await fsp.stat(full);
    if (st.isDirectory()) return { dir: full, partial: "" };
  } catch {
    // doesn't exist yet — treat the last segment as a partial name
  }
  const i = full.lastIndexOf("/");
  return { dir: i <= 0 ? "/" : full.slice(0, i), partial: full.slice(i + 1) };
}

/** `path:` autocomplete: library aliases + directory completion within libraries.
 *  `alias/sub` suggestions stay in alias form so the chip keeps working. */
async function pathComplete(typed: string): Promise<string[]> {
  const LIMIT = 20;
  const libs = config
    .get()
    .libraries.map((l) => ({ root: path.resolve(l.path), alias: l.alias }));
  if (!typed) return libs.map((l) => l.alias ?? l.root).slice(0, LIMIT);

  const slash = typed.indexOf("/");
  const head = slash === -1 ? typed : typed.slice(0, slash);
  const aliasLib = libs.find((l) => l.alias?.toLowerCase() === head.toLowerCase());

  if (aliasLib) {
    const rest = slash === -1 ? "" : typed.slice(slash + 1);
    const full = rest ? path.join(aliasLib.root, rest) : aliasLib.root;
    const { dir, partial } = await resolveDir(full);
    const names = await dirSuggestions(dir, partial);
    return names
      .map((n) => `${aliasLib.alias}/${path.relative(aliasLib.root, path.join(dir, n))}`)
      .slice(0, LIMIT);
  }

  const t = path.normalize(typed);
  if (t.startsWith("/")) {
    const roots = libs.map((l) => l.root);
    const lib = roots.find((l) => l === t || t.startsWith(l + "/"));
    if (lib) {
      const { dir, partial } = await resolveDir(t);
      return (await dirSuggestions(dir, partial)).map((n) => path.join(dir, n)).slice(0, LIMIT);
    }
    return roots.filter((r) => r.startsWith(t)).slice(0, LIMIT);
  }

  // partial alias (no slash)
  return libs
    .filter((l) => l.alias?.toLowerCase().startsWith(typed.toLowerCase()))
    .map((l) => l.alias!)
    .slice(0, LIMIT);
}

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
        // timeline scrubber seek: used only for the first page (when no page cursor yet)
        seek: z.string().nullish(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      if (input.ids) {
        return { items: await listByOrderedIds(input.ids), nextCursor: null, prevCursor: null };
      }
      const where = sourceWhere({
        pathPrefix: input.pathPrefix,
        tag: input.tag,
        recursive: input.recursive,
      });
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
    .query(({ input }) => timelineBuckets(sourceWhere(input), config.timelineRoots())),

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

  pathComplete: protectedProcedure
    .input(z.object({ typed: z.string() }))
    .query(({ input }) => pathComplete(input.typed)),
});
