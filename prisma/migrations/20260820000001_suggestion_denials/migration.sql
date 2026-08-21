-- CreateTable
CREATE TABLE "SuggestionDenial" (
    "tagName" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    CONSTRAINT "SuggestionDenial_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SuggestionDenial_tagName_idx" ON "SuggestionDenial"("tagName");

-- CreateIndex
CREATE UNIQUE INDEX "SuggestionDenial_tagName_fileId_key" ON "SuggestionDenial"("tagName", "fileId");

-- Migrate existing per-tag denials from Meta KV (key suggestionExclusion:<tag>, value = JSON array of fileIds)
INSERT OR IGNORE INTO "SuggestionDenial" ("tagName", "fileId")
SELECT substr(m.key, length('suggestionExclusion:') + 1), je.value
FROM "Meta" m, json_each(m.value) AS je
WHERE m.key LIKE 'suggestionExclusion:%' AND je.value IN (SELECT id FROM "File");
