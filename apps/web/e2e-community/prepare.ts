import { createDb } from "@opengmb/db";
import { runMigrations } from "../../../packages/db/src/migrate";

// Wipes the throwaway test database and migrates it with this tree's migration line, before the web server starts.
// Run with tsx: `tsx e2e-community/prepare.ts`, with DATABASE_URL in the environment.
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const { sql } = createDb(url);
  try {
    for (const schema of ["public", "drizzle", "pgboss"]) await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.unsafe("create schema public");
  } finally {
    await sql.end();
  }
  await runMigrations(url);
  console.log("[e2e-community] database wiped and migrated");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
