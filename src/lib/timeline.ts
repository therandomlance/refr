/** One month of the library timeline (shared by the server query and the client scrubber). */
export type TimelineBucket = {
  year: number;
  month: number; // 1-12
  count: number;
  minMtime: number; // oldest mtime in the month, ms epoch — mid-month seeking
  maxMtime: number; // newest mtime in the month, ms epoch — seek cursor source
};
