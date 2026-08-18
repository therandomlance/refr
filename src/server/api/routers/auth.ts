import { createTRPCRouter, publicProcedure } from "refr/server/api/trpc";
import { isOpen } from "refr/server/services/auth";

export const authRouter = createTRPCRouter({
  /** Public: whether the app requires a password, and whether the caller is authed. */
  status: publicProcedure.query(({ ctx }) => ({
    open: isOpen(),
    authed: ctx.authed,
  })),
});
