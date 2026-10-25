import { and, desc, eq, inArray } from "drizzle-orm";
import { aiVisibilityResults, aiVisibilityRuns, type Db, type Tx } from "@opengmb/db";
import { AI_ENGINES, type AiEngine } from "../config/ai-visibility";

export type TrendPoint = {
  runId: string;
  date: string;
  dataSource: "fixture" | "sandbox" | "live";
  /** Per engine: answers that named the business, answers received, share 0 to 1. Null when that engine gave no usable answer in the run. */
  engines: Partial<Record<AiEngine, { mentioned: number; answered: number; rate: number }>>;
};

export type LatestResult = { engine: AiEngine; prompt: string; mentioned: boolean; position: number | null; competitors: string[]; excerpt: string; error: string | null };

export type Overview = {
  trend: TrendPoint[];
  latest: { date: string; dataSource: "fixture" | "sandbox" | "live"; results: LatestResult[]; competitors: { name: string; mentions: number }[] } | null;
};

/** The mention rate per engine for the last `limit` runs (oldest first), and the latest run's answers. */
export async function aiVisibilityOverview(db: Db | Tx, orgId: string, locationId: string, limit = 12): Promise<Overview> {
  const runs = await db
    .select()
    .from(aiVisibilityRuns)
    .where(and(eq(aiVisibilityRuns.orgId, orgId), eq(aiVisibilityRuns.locationId, locationId)))
    .orderBy(desc(aiVisibilityRuns.createdAt))
    .limit(limit);
  if (runs.length === 0) return { trend: [], latest: null };
  const results = await db
    .select()
    .from(aiVisibilityResults)
    .where(and(eq(aiVisibilityResults.orgId, orgId), inArray(aiVisibilityResults.runId, runs.map((r) => r.id))));
  const known = new Set<string>(AI_ENGINES);
  const trend: TrendPoint[] = runs
    .map((run) => {
      const engines: TrendPoint["engines"] = {};
      for (const e of AI_ENGINES) {
        const answered = results.filter((r) => r.runId === run.id && r.engine === e && !r.error);
        if (answered.length) {
          const mentioned = answered.filter((r) => r.mentioned).length;
          engines[e] = { mentioned, answered: answered.length, rate: mentioned / answered.length };
        }
      }
      return { runId: run.id, date: run.createdAt.toISOString().slice(0, 10), dataSource: run.dataSource, engines };
    })
    .reverse();
  const newest = runs[0]!;
  const mine = results.filter((r) => r.runId === newest.id && known.has(r.engine));
  const tally = new Map<string, number>();
  for (const r of mine) for (const c of r.competitors) tally.set(c, (tally.get(c) ?? 0) + 1);
  return {
    trend,
    latest: {
      date: newest.createdAt.toISOString().slice(0, 10),
      dataSource: newest.dataSource,
      results: mine.map((r) => ({ engine: r.engine as AiEngine, prompt: r.prompt, mentioned: r.mentioned, position: r.position, competitors: r.competitors, excerpt: r.excerpt, error: r.error })),
      competitors: [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, mentions]) => ({ name, mentions })),
    },
  };
}
