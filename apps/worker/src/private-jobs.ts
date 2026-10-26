/** Community edition: no admin panel, so no extra scheduled jobs. Same names as the full module. */
import type { PgBoss } from "pg-boss";
import type { Db } from "@opengmb/db";

export async function registerPrivateJobs(_boss: PgBoss, _db: Db): Promise<void> {}
