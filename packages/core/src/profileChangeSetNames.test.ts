import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, users } from "@opengmb/db";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { makeKit, type Loc, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const { run } = kit;

type CS = {
  id: string;
  status: string;
  createdSurface: string;
  createdByName: string | null;
  approvedByName: string | null;
};

let org: Org;
let loc: Loc;
beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  org = await kit.makeOrg();
  loc = await org.mkLoc(org.a);
  await db.update(users).set({ name: "Marcus" }).where(eq(users.id, org.manager.userId));
  await db.update(users).set({ name: "Dr. Ramos" }).where(eq(users.id, org.approverA.userId));
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await sql.end();
});

async function propose(actor: Org["manager"]) {
  const fields = { description: `A plain new description ${Math.random().toString(36).slice(2, 8)}.` };
  const pv = await run<{ locations: { current: unknown }[] }>(actor, "profile.preview", {
    locationIds: [loc.row.id],
    fields,
  });
  const r = await run<{ changeSet: CS }>(actor, "profile.propose", {
    workspaceId: org.a,
    locationIds: [loc.row.id],
    fields,
    snapshots: [{ locationId: loc.row.id, current: pv.locations[0]!.current }],
  });
  return r.changeSet;
}

describe("change sets name who drafted and who approved them", () => {
  it("names the drafter at once and the approver after approval, in get and in list", async () => {
    const cs = await propose(org.manager);
    expect(cs).toMatchObject({ status: "pending_approval", createdByName: "Marcus", approvedByName: null });
    const ok = await run<{ changeSet: CS }>(org.approverA, "profile.approve", { id: cs.id });
    expect(ok.changeSet).toMatchObject({ status: "approved", approvedByName: "Dr. Ramos" });
    const got = await run<{ changeSet: CS }>(org.owner, "profile.changeSets.get", { id: cs.id });
    expect(got.changeSet).toMatchObject({ createdByName: "Marcus", approvedByName: "Dr. Ramos" });
    const listed = await run<{ changeSets: CS[] }>(org.owner, "profile.changeSets.list", { workspaceId: org.a });
    expect(listed.changeSets.find((c) => c.id === cs.id)).toMatchObject({
      createdByName: "Marcus",
      approvedByName: "Dr. Ramos",
    });
  });

  it("canary: an agent draft keeps the token owner's name and says mcp", async () => {
    const agent = { ...org.manager, surface: "mcp" as const, actorType: "api_token" as const };
    const cs = await propose(agent);
    expect(cs).toMatchObject({ createdSurface: "mcp", createdByName: "Marcus" });
  });
});
