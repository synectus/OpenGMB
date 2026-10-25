// Pure logic for the Keyword rank view on /geogrid (K4): position text and day-over-day change.
// A lower position number is better; null means "not found in the results we fetched".
import { enT, type Tr } from "./rank-tracking";

export const positionText = (rank: number | null, t: Tr = enT) =>
  rank === null ? t("keywords.notFound") : t("keywords.position", { rank });

/** Change from the previous reading to the latest one. Null when there is nothing to compare. */
export function positionChange(
  current: number | null,
  previous: number | null,
  hasPrevious: boolean,
  t: Tr = enT,
): { label: string; tone: "good" | "bad" | "neutral" } | null {
  if (!hasPrevious) return null;
  if (current === null && previous === null) return { label: t("keywords.same"), tone: "neutral" };
  if (previous === null) return { label: t("keywords.entered"), tone: "good" };
  if (current === null) return { label: t("keywords.droppedOut"), tone: "bad" };
  const d = previous - current;
  if (d > 0) return { label: t("keywords.up", { value: d }), tone: "good" };
  if (d < 0) return { label: t("keywords.down", { value: Math.abs(d) }), tone: "bad" };
  return { label: t("keywords.same"), tone: "neutral" };
}

/** "2026-10-24" -> "24 Oct" (the day is already a UTC day string). */
export function shortDay(ymd: string): string {
  const [, m, d] = ymd.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(d)} ${months[Number(m) - 1] ?? ""}`.trim();
}
