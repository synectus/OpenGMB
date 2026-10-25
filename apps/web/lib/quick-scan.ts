// Pure logic for the Quick scan tab: text, history rows, comparison. Unit tested; no React.
import { enT, rankDelta, type Tr } from "./rank-tracking";
import type { TimeFormat } from "./time-format";

export type ScanConfig = { id: string; workspaceId?: string; targetName: string; keywords: string[]; gridSize: number; radiusM: number };
export type ScanRun = {
  id: string;
  configId: string;
  keyword: string;
  status: "queued" | "running" | "done" | "failed";
  createdAt: string;
  finishedAt: string | null;
  summary: { averageRank: number | null; foundShare: number | null };
};

/** Same shape check as geogrid.quickScans.create; without the Places API nothing more is possible. */
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
export function checkPlaceId(s: string, t: Tr = enT): string | null {
  const v = s.trim();
  if (v === "") return t("scanCheck.placeIdEmpty");
  return PLACE_ID.test(v) ? null : t("scanCheck.placeIdBad");
}

export function gridShort(size: number, radiusM: number, t: Tr = enT): string {
  const r =
    radiusM >= 1000 ? t("grid.km", { value: Number((radiusM / 1000).toFixed(1)) }) : t("grid.m", { value: radiusM });
  return t("grid.short", { size, radius: r });
}

export function averageText(
  s: { averageRank: number | null; foundShare: number | null },
  status: string,
  t: Tr = enT,
): string {
  if (status !== "done" || s.averageRank === null) return "-";
  if (s.foundShare === 0) return t("scanCheck.notFound");
  return s.averageRank.toFixed(1);
}

const when = (r: ScanRun, tf: TimeFormat, ws?: string) => tf.dateTime(r.finishedAt ?? r.createdAt, ws);

/** History rows: one per run, newest first, with its scan's business, keyword and grid. */
export function scanRows(configs: ScanConfig[], runs: ScanRun[], tf: TimeFormat, t: Tr = enT) {
  const byId = new Map(configs.map((c) => [c.id, c]));
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.configId, (counts.get(r.configId) ?? 0) + 1);
  return [...runs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((r) => byId.has(r.configId))
    .map((r) => {
      const c = byId.get(r.configId)!;
      return {
        runId: r.id,
        configId: c.id,
        business: c.targetName,
        keyword: r.keyword,
        grid: gridShort(c.gridSize, c.radiusM, t),
        average: averageText(r.summary, r.status, t),
        scanned: when(r, tf, c.workspaceId),
        status: r.status,
        runCount: counts.get(c.id) ?? 0,
      };
    });
}

/** The two newest finished runs of one scan, oldest first, and the change (lower is better). */
export function compareScans(runs: ScanRun[], tf: TimeFormat, ws?: string, t: Tr = enT) {
  const done = runs
    .filter((r) => r.status === "done" && r.summary.averageRank !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2)
    .reverse();
  if (done.length < 2) return null;
  const [older, newer] = done as [ScanRun, ScanRun];
  const line = (r: ScanRun) =>
    t("scanCheck.compareLine", { date: tf.date(r.finishedAt ?? r.createdAt, ws), rank: r.summary.averageRank!.toFixed(1) });
  return {
    lines: [line(older), line(newer)],
    delta: rankDelta(newer.summary.averageRank, older.summary.averageRank, t),
  };
}
