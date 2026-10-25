import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgBoss } from "pg-boss";
import { createDb } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { AI_VISIBILITY_QUEUE, runAiVisibilityCheck } from "./ai-visibility/run";
import { codeOf, makeKit } from "./testkit";

// K5: the actions around the AI search visibility check: opt-in, cost preview, roles and the manual check.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const boss = new PgBoss(url);
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(AI_VISIBILITY_QUEUE);
});
afterAll(async () => {
  await boss.stop();
  await kit.deactivateAll();
  await sql.end();
});

type Got = { settings: { enabled: boolean; category: string; engines: string[] }; estimate: { providerUsd: number; chargedUsd: number } | null; trend: unknown[]; latest: unknown };

describe("K5 actions", () => {
  it("is off by default; switching on needs a category and a city; the estimate is shown to a manager only", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const id = loc.row.id;
    const off = await kit.run<Got>(org.manager, "aiVisibility.get", { locationId: id });
    expect(off.settings).toMatchObject({ enabled: false, category: "" });
    expect(off.settings.engines).toHaveLength(4);
    expect(off.estimate!.providerUsd).toBeCloseTo(0.0678, 4);
    expect(off.estimate!.chargedUsd).toBeGreaterThan(off.estimate!.providerUsd);
    expect(await codeOf(kit.run(org.manager, "aiVisibility.update", { locationId: id, enabled: true }))).toBe("INVALID_INPUT");
    await kit.run(org.manager, "aiVisibility.update", { locationId: id, enabled: true, category: "dentist", city: "Austin", engines: ["chatgpt", "perplexity"] });
    const on = await kit.run<Got>(org.manager, "aiVisibility.get", { locationId: id });
    expect(on.settings).toMatchObject({ enabled: true, category: "dentist", engines: ["chatgpt", "perplexity"] });
    expect(on.estimate!.providerUsd).toBeCloseTo(3 * (0.004 + 0.0106), 4);
    const seen = await kit.run<Got>(org.viewerA, "aiVisibility.get", { locationId: id });
    expect(seen.estimate).toBeNull();
    expect(await codeOf(kit.run(org.viewerA, "aiVisibility.update", { locationId: id, enabled: false }))).toBe("FORBIDDEN");
    expect(await codeOf(kit.run(org.viewerA, "aiVisibility.runNow", { locationId: id }))).toBe("FORBIDDEN");
  });

  it("another organization cannot read or change the location", async () => {
    const a = await kit.makeOrg();
    const b = await kit.makeOrg();
    const loc = await a.mkLoc(a.a);
    expect(await codeOf(kit.run(b.manager, "aiVisibility.get", { locationId: loc.row.id }))).toBe("NOT_FOUND");
    expect(await codeOf(kit.run(b.manager, "aiVisibility.update", { locationId: loc.row.id, enabled: false }))).toBe("NOT_FOUND");
  });

  it("a manual check needs the location switched on and is refused within an hour of the last one", async () => {
    const org = await kit.makeOrg();
    const loc = await org.mkLoc(org.a);
    const id = loc.row.id;
    expect(await codeOf(kit.run(org.manager, "aiVisibility.runNow", { locationId: id }))).toBe("INVALID_INPUT");
    await kit.run(org.manager, "aiVisibility.update", { locationId: id, enabled: true, category: "dentist", city: "Austin" });
    expect(await kit.run(org.manager, "aiVisibility.runNow", { locationId: id })).toEqual({ queued: true });
    const jobs = await boss.fetch<{ locationId: string; force: boolean }>(AI_VISIBILITY_QUEUE, { batchSize: 50 });
    expect(jobs.some((j) => j.data.locationId === id && j.data.force)).toBe(true);
    await runAiVisibilityCheck(db, id, { source: "fixture", force: true });
    expect(await codeOf(kit.run(org.manager, "aiVisibility.runNow", { locationId: id }))).toBe("INVALID_INPUT");
    const after = await kit.run<Got>(org.manager, "aiVisibility.get", { locationId: id });
    expect(after.trend).toHaveLength(1);
    expect(after.latest).not.toBeNull();
  });
});
