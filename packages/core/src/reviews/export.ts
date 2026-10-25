import type { ReviewRow } from "./queries";
import { rowNeedsYou } from "./reply-stage";

const BOM = "﻿";

/** Every column the export can carry, in the order they are written. The first nine are the long-standing default. */
export const EXPORT_COLUMNS = [
  "date",
  "location",
  "stars",
  "reviewer",
  "review",
  "reply",
  "replyDate",
  "replyState",
  "needsReply",
] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

const COLUMNS: Record<ExportColumn, { header: string; cell: (r: ReviewRow) => string | number | null }> = {
  date: { header: "Review date (UTC)", cell: (r) => r.createTime.toISOString() },
  location: { header: "Location", cell: (r) => r.locationName },
  stars: { header: "Stars", cell: (r) => r.starRating },
  reviewer: {
    header: "Reviewer",
    cell: (r) => (r.reviewerIsAnonymous ? "Anonymous" : r.reviewerDisplayName),
  },
  review: { header: "Review", cell: (r) => r.comment },
  reply: { header: "Reply", cell: (r) => r.replyComment },
  replyDate: { header: "Reply date (UTC)", cell: (r) => r.replyUpdateTime?.toISOString() ?? null },
  replyState: {
    header: "Google reply state",
    cell: (r) => (r.replyComment === null ? null : r.replyState),
  },
  needsReply: { header: "Needs reply", cell: (r) => (rowNeedsYou(r.replyStage) ? "yes" : "no") },
};

/**
 * One CSV field. A leading = + - @ tab or CR would be run as a formula by Excel and Sheets, so such a
 * field gets a single quote in front (it shows as text). Then RFC 4180: quote a field containing a
 * comma, quote, CR or LF, and double embedded quotes.
 */
export function csvField(v: string | number | null): string {
  if (v === null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * The reviews as a CSV string: UTF-8 BOM first (Excel needs it to read non-ASCII text as UTF-8), CRLF
 * line ends per RFC 4180, a header row, then one row per review in the order given. `columns` picks
 * which columns; they are always written in the canonical order above. Omitted = all nine.
 */
export function reviewsToCsv(rows: ReviewRow[], columns: readonly ExportColumn[] = EXPORT_COLUMNS): string {
  const picked = EXPORT_COLUMNS.filter((c) => columns.includes(c));
  const lines = [picked.map((c) => COLUMNS[c].header), ...rows.map((r) => picked.map((c) => COLUMNS[c].cell(r)))].map(
    (cells) => cells.map(csvField).join(","),
  );
  return BOM + lines.join("\r\n") + "\r\n";
}
