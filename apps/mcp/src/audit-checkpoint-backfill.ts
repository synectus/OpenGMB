import { backfillAuditCheckpoint } from "@opengmb/core";
import { createDb, organizations } from "@opengmb/db";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const { db, sql } = createDb(url);
try {
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations);
  const counts: Record<string, number> = {};
  let failed = 0;
  for (const org of orgs) {
    const result = await backfillAuditCheckpoint(db, org.id);
    counts[result.kind] = (counts[result.kind] ?? 0) + 1;
    const extra =
      result.kind === "written"
        ? ` (${result.rowCount} rows covered, including the backfill audit row)`
        : result.kind === "refused_chain_broken"
          ? ` ${JSON.stringify(result.breaks)}`
          : "";
    if (result.kind === "refused_chain_broken") failed++;
    console.log(`${org.id}  ${org.name}  ${result.kind}${extra}`);
  }
  console.log(`${orgs.length} orgs inspected: ${JSON.stringify(counts)}`);
  if (orgs.length === 0) throw new Error("No organizations found; nothing was inspected");
  if (failed > 0) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
