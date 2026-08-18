import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { db } from "refr/server/db";
import { SESSION_COOKIE, verifySession } from "refr/server/services/auth";

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const cookieHeader = opts.headers.get("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]*)`).exec(cookieHeader);
  const sessionValue = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  return {
    db,
    authed: verifySession(sessionValue),
    ...opts,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const createTRPCRouter = t.router;

export const publicProcedure = t.procedure;

/** Everything except auth.login/status goes through this. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.authed) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx });
});
