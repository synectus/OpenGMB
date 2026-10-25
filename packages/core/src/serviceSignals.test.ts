import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, monitorState } from "@opengmb/db";
import { recordHeartbeat } from "./monitoring/worker";
import { readServiceSignals } from "./service-signals";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

describe("readServiceSignals", () => {
  it("reports the database up and the worker's last heartbeat, or null when there never was one", async () => {
    await db.delete(monitorState).where(eq(monitorState.key, "worker_heartbeat"));
    expect((await readServiceSignals(db)).workerLastActivityAt).toBeNull();
    const at = new Date(Date.now() - 1000);
    await recordHeartbeat(db, at);
    try {
      const s = await readServiceSignals(db);
      expect(s.databaseUp).toBe(true);
      expect(s.workerLastActivityAt!.getTime()).toBe(at.getTime());
    } finally {
      await db.delete(monitorState).where(eq(monitorState.key, "worker_heartbeat"));
    }
  });
  it("throws when the database cannot be reached, so the page can say it is down", async () => {
    const dead = createDb("postgres://nobody:none@127.0.0.1:1/none");
    await expect(readServiceSignals(dead.db)).rejects.toThrow();
    await dead.sql.end({ timeout: 1 }).catch(() => undefined);
  });
});
