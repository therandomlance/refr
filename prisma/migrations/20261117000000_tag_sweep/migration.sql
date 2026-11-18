-- Additive only: derived cache tables for the tagging inbox. IF NOT EXISTS
-- because instrumentation-node.ts may create them first when the Prisma CLI
-- is unavailable.
CREATE TABLE IF NOT EXISTS "TagCandidate" (
    "tagId" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "score" REAL NOT NULL,
    "mode" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "rivalTag" TEXT,
    "rivalConfidence" REAL,
    "nearDenial" BOOLEAN NOT NULL,
    "sweptAt" DATETIME NOT NULL,

    PRIMARY KEY ("tagId", "fileId"),
    CONSTRAINT "TagCandidate_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TagCandidate_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TagCandidate_tagId_rank_idx" ON "TagCandidate"("tagId", "rank");
CREATE INDEX IF NOT EXISTS "TagCandidate_fileId_idx" ON "TagCandidate"("fileId");

CREATE TABLE IF NOT EXISTS "TagSweep" (
    "tagId" INTEGER NOT NULL PRIMARY KEY,
    "positives" INTEGER NOT NULL,
    "modes" INTEGER NOT NULL,
    "exemplars" TEXT NOT NULL,
    "sweptAt" DATETIME NOT NULL,
    CONSTRAINT "TagSweep_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
