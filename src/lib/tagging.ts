/** Tagging inbox constants shared by the server (services/tagging.ts) and the /tagging page. */

/** Candidates below this confidence are never shown (not even as "uncertain"). */
export const UNCERTAIN_FLOOR = 0.15;
/** Default "ready" threshold: scores as high as 60% of the tag's own images. */
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const BATCH_SIZE = 40;

export const formatConfidence = (c: number) => `${Math.round(c * 100)}%`;
