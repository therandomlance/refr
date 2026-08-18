-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "size" BIGINT NOT NULL,
    "mtime" DATETIME NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration" REAL,
    "mediaType" TEXT NOT NULL,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FilePath" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "path" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mtime" DATETIME NOT NULL,
    CONSTRAINT "FilePath_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL COLLATE NOCASE
);

-- CreateTable
CREATE TABLE "FileTag" (
    "fileId" TEXT NOT NULL,
    "tagId" INTEGER NOT NULL,
    CONSTRAINT "FileTag_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileEmbedding" (
    "fileId" TEXT NOT NULL PRIMARY KEY,
    "vector" BLOB NOT NULL,
    "model" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FileEmbedding_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TagVector" (
    "tagId" INTEGER NOT NULL PRIMARY KEY,
    "vector" BLOB NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "linksVersion" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    CONSTRAINT "TagVector_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Meta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "File_mtime_id_idx" ON "File"("mtime", "id");

-- CreateIndex
CREATE INDEX "File_mediaType_idx" ON "File"("mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "FilePath_path_key" ON "FilePath"("path");

-- CreateIndex
CREATE INDEX "FilePath_fileId_idx" ON "FilePath"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "Tag_name_idx" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "FileTag_tagId_fileId_idx" ON "FileTag"("tagId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "FileTag_fileId_tagId_key" ON "FileTag"("fileId", "tagId");
