import { createDb } from "@opengmb/db";

// Waits until the web server's first start has created the owner from OWNER_EMAIL: `tsx e2e-community/wait-owner.ts`.
async function main() {
  const url = process.env.DATABASE_URL;
  const email = process.env.OWNER_EMAIL;
  if (!url || !email) throw new Error("DATABASE_URL and OWNER_EMAIL are required");
  const { sql } = createDb(url);
  const until = Date.now() + 60_000;
  try {
    for (;;) {
      const rows = await sql`select 1 from users where email = ${email}`;
      if (rows.length === 1) return;
      if (Date.now() > until) throw new Error("the owner was not created within 60s");
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    await sql.end();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
