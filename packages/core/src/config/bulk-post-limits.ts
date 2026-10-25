/**
 * Our own bounds on a bulk post import (P2). Not Google numbers: they keep one request, one
 * transaction and one preview table a sensible size. Raise them here, nowhere else.
 */
export const BULK_POST_LIMITS = {
  /** Data rows (not counting the header) in one import. */
  maxRows: 500,
  /** Size of the pasted or uploaded text, in UTF-16 units. */
  maxChars: 1_000_000,
} as const;
