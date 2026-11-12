-- Additive only: a new cache table for experimental per-tag classifiers.
-- Existing tables are untouched. IF NOT EXISTS because instrumentation.ts may
-- create it first when the Prisma CLI is unavailable.
CREATE TABLE IF NOT EXISTS "TagClassifier" (
    "tagId" INTEGER NOT NULL,
    "variant" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "weights" BLOB,
    "bias" REAL,
    "positives" INTEGER NOT NULL,
    "negatives" INTEGER NOT NULL,

    PRIMARY KEY ("tagId", "variant", "model"),
    CONSTRAINT "TagClassifier_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TagClassifier_variant_model_idx" ON "TagClassifier"("variant", "model");
