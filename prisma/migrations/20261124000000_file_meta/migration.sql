-- Additive only. IF NOT EXISTS because instrumentation-node.ts may create these
-- first when the Prisma CLI is unavailable.
CREATE TABLE IF NOT EXISTS "FileMeta" (
    "fileId" TEXT NOT NULL PRIMARY KEY,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "dhash" BIGINT,
    "duplicateOf" TEXT,
    "source" TEXT,
    "note" TEXT,
    "takenAt" DATETIME,
    "camera" TEXT,
    "exifChecked" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "FileMeta_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "FileMeta_favorite_idx" ON "FileMeta"("favorite");
CREATE INDEX IF NOT EXISTS "FileMeta_duplicateOf_idx" ON "FileMeta"("duplicateOf");

CREATE TABLE IF NOT EXISTS "DuplicateDismissal" (
    "a" TEXT NOT NULL,
    "b" TEXT NOT NULL,
    PRIMARY KEY ("a", "b")
);
