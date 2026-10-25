import { seedMockGoogleConnection } from "@opengmb/core";
import { createDb } from "@opengmb/db";

const [email] = process.argv.slice(2);
if (!email) {
  console.error("usage: pnpm dev:seed-google <email>");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const { db, sql } = createDb(url);
try {
  const r = await seedMockGoogleConnection(db, email);
  console.log(
    `${r.created ? "Created" : "Reused existing"} mock Google connection ${r.connectionId} for org ${r.orgId}`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
