import { seedMockGoogleConnection } from "@opengmb/core";
import { createDb } from "@opengmb/db";

// The mock "Connect Google" step for the owner: `tsx e2e-community/mock-google.ts <email>`.
// The real button needs Google OAuth credentials, which e2e never has; this is the same row the
// OAuth callback would store (the helper refuses outside mock mode).
async function main() {
  const email = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!email || !url) throw new Error("usage: DATABASE_URL=... tsx e2e-community/mock-google.ts <email>");
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  const { db, sql } = createDb(url);
  const r = await seedMockGoogleConnection(db, email);
  console.log(`mock Google connection ${r.connectionId} (created: ${r.created})`);
  await sql.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
