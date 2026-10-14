-- Keep cache freshness checks from scanning embedding blobs on every kNN request.
CREATE INDEX "FileEmbedding_model_updatedAt_idx" ON "FileEmbedding"("model", "updatedAt");
