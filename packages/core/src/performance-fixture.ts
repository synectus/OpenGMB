/** Test-only fixture builder shared by the performance and reports tests. Not exported from core. */
import {
  createDb,
  googleConnections,
  locations,
  memberships,
  organizations,
  performanceDaily,
  searchKeywordsMonthly,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor } from "./actor";
import { CoreError } from "./errors";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
export const { db, sql } = createDb(url);

export const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? `${e.code}:${e.message}` : `other:${String(e)}`;
  }
  return "no error";
}

export async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const mkUser = async (
    role: "owner" | "admin" | "manager" | "client_viewer",
    workspaceId?: string,
  ) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  };
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const connUser = `u-${uniq()}`;
  await db.insert(users).values({ id: connUser, name: "C", email: `${connUser}@example.test` });
  const [conn] = await db
    .insert(googleConnections)
    .values({
      orgId,
      userId: connUser,
      googleAccountId: `g-${uniq()}`,
      googleAccountEmail: `${connUser}@example.test`,
      refreshTokenEnc: "enc",
      scopes: [],
    })
    .returning();
  const mkLoc = async (workspaceId: string, title: string, status: "active" | "inactive") => {
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId,
        connectionId: conn!.id,
        name: `locations/${uniq()}`,
        googleLocationId: `locations/${uniq()}`,
        title,
        status,
      })
      .returning();
    return l!;
  };
  return {
    orgId,
    wsA: a!.id,
    wsB: b!.id,
    locA1: await mkLoc(a!.id, "Acme Dental", "active"),
    locA2: await mkLoc(a!.id, "Acme Dental North", "active"),
    locAOff: await mkLoc(a!.id, "Acme Closed", "inactive"),
    locB: await mkLoc(b!.id, "Other Co", "active"),
    owner: await mkUser("owner"),
    manager: await mkUser("manager"),
    viewerA: await mkUser("client_viewer", a!.id),
    viewerB: await mkUser("client_viewer", b!.id),
  };
}
export type Org = Awaited<ReturnType<typeof makeOrg>>;

export async function putDaily(
  orgId: string,
  locationId: string,
  rows: [date: string, metric: string, value: number][],
) {
  await db
    .insert(performanceDaily)
    .values(rows.map(([date, metric, value]) => ({ orgId, locationId, date, metric, value })));
}

export async function putKeywords(
  orgId: string,
  locationId: string,
  rows: [month: string, keyword: string, value: number | null, threshold: number | null][],
) {
  await db.insert(searchKeywordsMonthly).values(
    rows.map(([month, keyword, value, threshold]) => ({
      orgId,
      locationId,
      month,
      keyword,
      value,
      threshold,
    })),
  );
}
