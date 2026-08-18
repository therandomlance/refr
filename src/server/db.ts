import { env } from "refr/env";
import { PrismaClient } from "../../generated/prisma";
import { initDataDir, paths } from "./services/dataDir";

const createPrismaClient = () => {
  initDataDir();
  const client = new PrismaClient({
    datasources: { db: { url: `file:${paths.db}` } },
    log: env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  void client.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch(() => undefined);
  void client.$queryRawUnsafe("PRAGMA foreign_keys=ON").catch(() => undefined);
  return client;
};

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") globalForPrisma.prisma = db;
