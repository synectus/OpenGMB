import { createApiToken } from "@opengmb/core";
import { createDb } from "@opengmb/db";

const args = process.argv.slice(2);
const readOnly = args.includes("--read-only");
const fullAutonomy = args.includes("--full-autonomy");
const [email, name] = args.filter((a) => a !== "--read-only" && a !== "--full-autonomy");
if (!email) {
  console.error("usage: pnpm token:create <email> [name] [--read-only] [--full-autonomy]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const { db, sql } = createDb(url);
try {
  const { token, row } = await createApiToken(db, {
    email,
    name,
    readOnly,
    mode: fullAutonomy ? "full_autonomy" : "human_in_the_loop",
  });
  const port = process.env.MCP_PORT ?? "3100";
  console.log(
    `Created ${readOnly ? "read-only " : ""}${fullAutonomy ? "full-autonomy" : "human-in-the-loop"} API token "${row.name}" (${row.id}). It is shown once and cannot be recovered.\n`,
  );
  console.log(token + "\n");
  console.log(
    `claude mcp add --transport http opengmb http://localhost:${port}/mcp --header "Authorization: Bearer ${token}"`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
