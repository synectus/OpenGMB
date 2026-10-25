// pnpm exec tsx packages/core/scripts/attention-plans.ts --db syngmb_scale_x   (from the repo root)
// EXPLAIN (ANALYZE, BUFFERS) for every query the shell runs on each page (attention.counts), against a database
// seeded by `pnpm scale`/seed.ts (name must be syngmb_test_* or syngmb_scale_*). Prints the SQL, then the plan.
// Also prints the median wall time of the whole count over 7 runs.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { countAttention } from "../src/attention";
import type { Actor } from "../src/actor";
import * as schema from "@opengmb/db";
import { createDb } from "@opengmb/db";
import { dbUrlFor, findEnvFile } from "../../../scripts/gate-lib.mjs";

const i = process.argv.indexOf("--db");
const dbName = i < 0 ? undefined : process.argv[i + 1];
if (!dbName || !/^syngmb_(test|scale)_/.test(dbName)) throw new Error("pass --db syngmb_test_* or syngmb_scale_*");
const envFile = findEnvFile(process.cwd());
const base = process.env.DATABASE_URL_TEST ?? (envFile ? parseEnv(readFileSync(envFile, "utf8")).DATABASE_URL_TEST : undefined);
if (!base) throw new Error("DATABASE_URL_TEST is not set");
const { sql } = createDb(dbUrlFor(base, dbName));
const captured: { q: string; params: unknown[] }[] = [];
const db = drizzle(sql, { schema, logger: { logQuery: (q, params) => void captured.push({ q, params }) } });

const [m] = await sql<{ org_id: string; user_id: string }[]>`select org_id, user_id from memberships order by created_at limit 1`;
const actor: Actor = { userId: m!.user_id, orgId: m!.org_id, role: "owner", workspaceIds: "all", surface: "ui", actorType: "user" };

const times: number[] = [];
let result: Awaited<ReturnType<typeof countAttention>> | undefined;
for (let n = 0; n < 7; n++) {
  captured.length = 0;
  const t = performance.now();
  result = await countAttention(db, actor, undefined, new Date());
  times.push(performance.now() - t);
}
console.log(`counts: ${JSON.stringify(result!.counts)}`);
times.sort((a, b) => a - b);
console.log(`attention.counts wall time over 7 runs: median ${times[3]!.toFixed(0)} ms, min ${times[0]!.toFixed(0)}, max ${times[6]!.toFixed(0)}\n`);
for (const c of captured) {
  if (!/^select/i.test(c.q)) continue;
  console.log(`-- ${c.q.replace(/\s+/g, " ").slice(0, 400)}`);
  const plan = await sql.unsafe(`explain (analyze, buffers) ${c.q}`, c.params as never[]);
  console.log(plan.map((r) => r["QUERY PLAN"]).join("\n"), "\n");
}
await sql.end();
