import { authRouter } from "refr/server/api/routers/auth";
import { browseRouter } from "refr/server/api/routers/browse";
import { filesRouter } from "refr/server/api/routers/files";
import { mlRouter } from "refr/server/api/routers/ml";
import { palettesRouter } from "refr/server/api/routers/palettes";
import { queueRouter } from "refr/server/api/routers/queue";
import { searchRouter } from "refr/server/api/routers/search";
import { searchesRouter } from "refr/server/api/routers/searches";
import { sessionsRouter } from "refr/server/api/routers/sessions";
import { settingsRouter } from "refr/server/api/routers/settings";
import { tagsRouter } from "refr/server/api/routers/tags";
import { createCallerFactory, createTRPCRouter } from "refr/server/api/trpc";

export const appRouter = createTRPCRouter({
  auth: authRouter,
  files: filesRouter,
  tags: tagsRouter,
  search: searchRouter,
  ml: mlRouter,
  searches: searchesRouter,
  browse: browseRouter,
  queue: queueRouter,
  sessions: sessionsRouter,
  palettes: palettesRouter,
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
