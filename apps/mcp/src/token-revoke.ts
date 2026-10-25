import { parseArgs } from "node:util";
import {
  findActiveTokensByName,
  resolveRevokeTarget,
  revokeApiTokenAsCli,
  type ActiveTokenMatch,
} from "@opengmb/core";
import { createDb } from "@opengmb/db";

const usage = "usage: pnpm token:revoke <name> [--email <owner email>] [--id <token uuid>]";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { email: { type: "string" }, id: { type: "string" } },
});
const [name] = positionals;
if (!name || positionals.length > 1) {
  console.error(usage);
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const describe = (m: ActiveTokenMatch) =>
  `  ${m.id}  ${m.ownerEmail}  ${m.orgName}  ${m.createdAt.toISOString()}`;

const { db, sql } = createDb(url);
try {
  const all = await findActiveTokensByName(db, name);
  const result = resolveRevokeTarget(all, values);
  if (result.kind === "none") {
    console.error(`No active API token named "${name}" matches.`);
    process.exitCode = 1;
  } else if (result.kind === "ambiguous") {
    console.error(
      `${result.matches.length} active tokens named "${name}" (id, owner, org, created):`,
    );
    console.error(result.matches.map(describe).join("\n"));
    console.error(
      result.next === "email"
        ? "Refusing to guess. Re-run with --email <owner email> to pick one."
        : "Still ambiguous after --email. Re-run with --id <uuid> from the list above.",
    );
    process.exitCode = 1;
  } else {
    const { apiToken } = await revokeApiTokenAsCli(db, result.match);
    console.log(
      `Revoked API token "${apiToken.name}" (${apiToken.id}) owned by ${apiToken.ownerEmail}.`,
    );
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
