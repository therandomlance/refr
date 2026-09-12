/** One month of the library timeline (shared by the server query and the client scrubber). */
export type TimelineBucket = {
  year: number;
  month: number; // 1-12
  count: number;
  maxMtime: number; // newest mtime in the month, ms epoch — source of the seek cursor
};
