-- IF NOT EXISTS because instrumentation.ts may create this table first when
-- `prisma migrate deploy` fails; the data copy below is INSERT OR IGNORE.
-- CreateTable
CREATE TABLE IF NOT EXISTS "SuggestionDenial" (
    "tagName" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    CONSTRAINT "SuggestionDenial_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SuggestionDenial_tagName_idx" ON "SuggestionDenial"("tagName");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SuggestionDenial_tagName_fileId_key" ON "SuggestionDenial"("tagName", "fileId");

-- Migrate existing per-tag denials from Meta KV (key suggestionExclusion:<tag>, value = JSON array of fileIds)
INSERT OR IGNORE INTO "SuggestionDenial" ("tagName", "fileId")
SELECT substr(m.key, length('suggestionExclusion:') + 1), je.value
FROM "Meta" m, json_each(m.value) AS je
WHERE m.key LIKE 'suggestionExclusion:%' AND je.value IN (SELECT id FROM "File");
