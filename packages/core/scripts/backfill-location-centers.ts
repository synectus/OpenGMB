// One-off: queue a coordinate lookup for every active Google-linked location that has none.
//   DATABASE_URL=... tsx packages/core/scripts/backfill-location-centers.ts            (dry run: counts only)
//   DATABASE_URL=... tsx packages/core/scripts/backfill-location-centers.ts --apply    (queues the jobs)
// The worker's locations.center_resolve queue does the lookups (Google, Places if a key is set,
// DataForSEO under the platform's daily cap, the rank tracker). Safe to run again. It prints the
// database host first and queues nothing without --apply.
import { createDb } from "@opengmb/db";
import { enqueueLocationCenterBackfill } from "../src/locations/center-backfill";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const apply = process.argv.includes("--apply");
const { db, sql } = createDb(url);
console.log(`database host: ${new URL(url).host}; ${apply ? "APPLY" : "dry run"}`);
const r = await enqueueLocationCenterBackfill(db, { dryRun: !apply });
console.log(`${r.candidates} location(s) without coordinates; ${r.enqueued} queued`);
await sql.end();
