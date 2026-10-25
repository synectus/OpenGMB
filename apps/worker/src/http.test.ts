import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { verifyAuditChain, type PubsubVerifyConfig } from "@opengmb/core";
import {
  auditLog,
  createDb,
  googleNotifications,
  locations,
  organizations,
  workspaces,
} from "@opengmb/db";
import {
  googleUpdate,
  newReview,
  newReviewObservedShape,
  pushEnvelope,
  updatedReview,
} from "./fixtures/pubsub";
import { GOOGLE_NOTIFICATION_QUEUE, processGoogleNotification } from "./google-notification";
import { startServer } from "./http";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);

const AUD = "https://worker.test/webhooks/google-pubsub";
const SA = "push@syngmb-fake.iam.gserviceaccount.com";
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: Key;
let config: PubsubVerifyConfig;
let orgId: string;
let locationId: string;
// A unique location per run: the shared test DB keeps rows from earlier runs.
const locName = `locations/${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const mid = () => `m-${uniq()}`;

type Claims = {
  aud?: string;
  email?: string;
  email_verified?: boolean;
  iss?: string;
  exp?: number;
};
async function token(over: Claims = {}, key: Key = privateKey) {
  const c = {
    aud: AUD,
    iss: "https://accounts.google.com",
    email: SA,
    email_verified: true,
    ...over,
  };
  return new SignJWT({ email: c.email, email_verified: c.email_verified })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(c.iss)
    .setAudience(c.aud!)
    .setIssuedAt()
    .setExpirationTime(c.exp ?? "5m")
    .sign(key);
}
async function post(body: unknown, bearer?: string | null) {
  return fetch(`${base}/webhooks/google-pubsub`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer ?? (await token())}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const rowsFor = (messageId: string) =>
  db.select().from(googleNotifications).where(eq(googleNotifications.pubsubMessageId, messageId));
const auditRows = async () =>
  (await db.select().from(auditLog).where(eq(auditLog.orgId, orgId))).filter(
    (r) => r.action === "google_notification.received",
  );
const jobsFor = async (notificationId: string) =>
  (
    await sql<
      { id: string }[]
    >`select id from pgboss.job where name = ${GOOGLE_NOTIFICATION_QUEUE} and data->>'notificationId' = ${notificationId}`
  ).length;
const loc = (id: string) => `accounts/1/${id}`;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  config = { audience: AUD, serviceAccountEmail: SA, jwks: createLocalJWKSet({ keys: [jwk] }) };

  boss.on("error", (e) => console.error(e));
  await boss.start();
  await boss.createQueue(GOOGLE_NOTIFICATION_QUEUE);

  const [o] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  orgId = o!.id;
  const [w] = await db.insert(workspaces).values({ orgId, name: "ws" }).returning();
  const [l] = await db
    .insert(locations)
    .values({ orgId, workspaceId: w!.id, name: "Loc", googleLocationId: locName })
    .returning();
  locationId = l!.id;
  server = await startServer(0, { db, boss, pubsub: config });
  base = `http://localhost:${server.port}`;
});
afterAll(async () => {
  await server.close();
  await boss.stop();
  await sql.end();
});

describe("healthz", () => {
  it("returns 200", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("accepted notifications", () => {
  const cases = [
    ["NEW_REVIEW", newReview, true],
    ["UPDATED_REVIEW", updatedReview, true],
    ["GOOGLE_UPDATE", googleUpdate, false],
  ] as const;
  for (const [type, make, hasResource] of cases) {
    it(`${type}: stored once with org/location, audited, job enqueued`, async () => {
      const id = mid();
      const before = (await auditRows()).length;
      const res = await post(make(id, loc(locName)));
      expect(res.status).toBe(204);
      const rows = await rowsFor(id);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({ orgId, locationId, type, locationName: locName });
      expect(row.resourceName === null).toBe(!hasResource);
      expect(row.publishTime?.toISOString()).toBe("2026-10-12T09:30:00.123Z");
      expect(row.processedAt).toBeNull();

      const audits = await auditRows();
      expect(audits).toHaveLength(before + 1);
      const a = audits.find((r) => r.entityId === row.id)!;
      expect(a).toMatchObject({
        surface: "worker",
        actorType: "system",
        actorUserId: null,
        entityType: "google_notification",
      });
      expect(a.after).toEqual({
        type,
        locationName: locName,
        resourceName: row.resourceName,
        messageId: id,
      });
      expect(await jobsFor(row.id)).toBe(1);
    });
  }

  it("accepts the {type, location, review} spelling", async () => {
    const id = mid();
    const env = newReviewObservedShape(id);
    env.message.data = Buffer.from(
      JSON.stringify({
        type: "NEW_REVIEW",
        location: loc(locName),
        review: `${loc(locName)}/reviews/x`,
      }),
    ).toString("base64");
    expect((await post(env)).status).toBe(204);
    expect((await rowsFor(id))[0]).toMatchObject({ type: "NEW_REVIEW", locationName: locName });
  });

  it("duplicate messageId: one row, one audit row, one job", async () => {
    const id = mid();
    const before = (await auditRows()).length;
    expect((await post(newReview(id, loc(locName)))).status).toBe(204);
    expect((await post(newReview(id, loc(locName)))).status).toBe(204);
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect((await auditRows()).length).toBe(before + 1);
    expect(await jobsFor(rows[0]!.id)).toBe(1);
  });

  it("job handler sets processed_at, idempotently", async () => {
    const id = mid();
    await post(googleUpdate(id, loc(locName)));
    const row = (await rowsFor(id))[0]!;
    await processGoogleNotification(db, row.id);
    const first = (await rowsFor(id))[0]!.processedAt;
    expect(first).toBeInstanceOf(Date);
    await processGoogleNotification(db, row.id);
    expect((await rowsFor(id))[0]!.processedAt).toEqual(first);
  });

  it("audit chain verifies for the org afterwards", async () => {
    const v = await verifyAuditChain(db, orgId);
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(0);
  });
});

describe("acknowledged but dropped", () => {
  it("inactive location: 204, nothing stored; active again: stored", async () => {
    const name = `locations/inactive-${uniq()}`;
    const [w] = await db.select().from(workspaces).where(eq(workspaces.orgId, orgId));
    const [l] = await db
      .insert(locations)
      .values({
        orgId,
        workspaceId: w!.id,
        name: "Off",
        googleLocationId: name,
        status: "inactive",
      })
      .returning();
    const id = mid();
    expect((await post(newReview(id, loc(name)))).status).toBe(204);
    expect(await rowsFor(id)).toHaveLength(0);
    await db.update(locations).set({ status: "active" }).where(eq(locations.id, l!.id));
    const id2 = mid();
    expect((await post(newReview(id2, loc(name)))).status).toBe(204);
    expect(await rowsFor(id2)).toHaveLength(1);
  });
  it("unknown location: 204, nothing stored", async () => {
    const id = mid();
    const res = await post(newReview(id, "accounts/1/locations/does-not-exist"));
    expect(res.status).toBe(204);
    expect(await rowsFor(id)).toHaveLength(0);
  });
  it("malformed data / envelope / body / unsupported type / oversize: 204, nothing stored", async () => {
    const id = mid();
    const bad = pushEnvelope({ hello: "world" }, id);
    expect((await post(bad)).status).toBe(204);
    expect(
      (
        await post(
          pushEnvelope({ notificationType: "NEW_CUSTOMER_MEDIA", locationName: loc(locName) }, id),
        )
      ).status,
    ).toBe(204);
    expect((await post({ nope: true })).status).toBe(204);
    expect((await post("not json")).status).toBe(204);
    expect((await post("x".repeat(70 * 1024))).status).toBe(204);
    expect(await rowsFor(id)).toHaveLength(0);
  });
});

describe("authentication", () => {
  const env = () => newReview(mid(), loc(locName));
  it("missing header", async () => expect((await post(env(), null)).status).toBe(401));
  it("wrong aud", async () =>
    expect((await post(env(), await token({ aud: "https://other" }))).status).toBe(401));
  it("wrong email", async () =>
    expect((await post(env(), await token({ email: "evil@x.test" }))).status).toBe(401));
  it("email_verified false", async () =>
    expect((await post(env(), await token({ email_verified: false }))).status).toBe(401));
  it("wrong issuer", async () =>
    expect((await post(env(), await token({ iss: "https://evil.test" }))).status).toBe(401));
  it("expired", async () =>
    expect(
      (await post(env(), await token({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status,
    ).toBe(401));
  it("bad signature", async () => {
    const other = await generateKeyPair("RS256");
    expect((await post(env(), await token({}, other.privateKey))).status).toBe(401);
  });
  it("rejected requests store nothing", async () => {
    const e = env();
    await post(e, null);
    expect(await rowsFor(e.message.messageId)).toHaveLength(0);
  });
  it("not configured: 503", async () => {
    const s = await startServer(0, { db, boss, pubsub: null });
    try {
      const res = await fetch(`http://localhost:${s.port}/webhooks/google-pubsub`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(503);
    } finally {
      await s.close();
    }
  });
});
