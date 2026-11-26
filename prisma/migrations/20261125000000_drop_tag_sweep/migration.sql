-- The tagging inbox (background sweep) was removed; drop its derived caches.
DROP TABLE IF EXISTS "TagCandidate";
DROP TABLE IF EXISTS "TagSweep";
DELETE FROM "Meta" WHERE "key" = 'tagSweep:lastFull';
