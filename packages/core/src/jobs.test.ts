import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { createDb } from "@opengmb/db";
import { enqueueJob } from "./jobs";

const url = process.env.DATABASE_URL_TEST!;
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const Q = "core-jobs-test";
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(Q);
});
afterAll(async () => {
  await boss.stop();
  await sql.end();
});
const count = async (tag: string) =>
  (
    await sql<
      { id: string }[]
    >`select id from pgboss.job where name = ${Q} and data->>'tag' = ${tag}`
  ).length;

describe("enqueueJob", () => {
  it("commits with the transaction and rolls back with it", async () => {
    const ok = `ok-${Date.now()}`;
    const bad = `bad-${Date.now()}`;
    await db.transaction((tx) => enqueueJob(tx, Q, { tag: ok }));
    await expect(
      db.transaction(async (tx) => {
        await enqueueJob(tx, Q, { tag: bad });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await count(ok)).toBe(1);
    expect(await count(bad)).toBe(0);
  });
});
