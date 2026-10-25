import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { GOOGLE_NOTIFICATION_QUEUE, ensureQueues } from "@opengmb/core";
import { createDb, locations, organizations, workspaces } from "@opengmb/db";
import { handlePubsubPush } from "./pubsub-receiver";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);

const AUD = "https://app.test/webhooks/google-pubsub";
const SA = "push@syngmb-fake.iam.gserviceaccount.com";
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const locName = `locations/${Date.now()}${Math.floor(Math.random() * 1e6)}`;

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: Key;
let otherKey: Key;
let jwks: ReturnType<typeof createLocalJWKSet>;

async function token(over: { aud?: string; email?: string; verified?: boolean; exp?: string | number } = {}, key: Key = privateKey) {
  return new SignJWT({ email: over.email ?? SA, email_verified: over.verified ?? true })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(over.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "5m")
    .sign(key);
}
const envelope = (messageId: string) => ({
  message: {
    data: Buffer.from(
      JSON.stringify({
        notificationType: "NEW_REVIEW",
        locationName: `accounts/1/${locName}`,
        reviewName: `accounts/1/${locName}/reviews/R1`,
      }),
    ).toString("base64"),
    messageId,
    publishTime: "2026-10-25T09:30:00.123Z",
  },
  subscription: "projects/fake/subscriptions/s",
});
const push = (body: unknown, bearer?: string | null) =>
  new Request("https://app.test/webhooks/google-pubsub", {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const call = (req: Request) => handlePubsubPush(req, db, jwks);
const rows = (id: string) =>
  sql<{ id: string; type: string; location_name: string }[]>`select id, type, location_name from google_notifications where pubsub_message_id = ${id}`;
const jobs = async (notificationId: string) =>
  (await sql<{ id: string }[]>`select id from pgboss.job where name = ${GOOGLE_NOTIFICATION_QUEUE} and data->>'notificationId' = ${notificationId}`).length;

const saved = { aud: process.env.PUBSUB_AUDIENCE, sa: process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL };
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
  await ensureQueues(url, [GOOGLE_NOTIFICATION_QUEUE]);
  const [o] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const [w] = await db.insert(workspaces).values({ orgId: o!.id, name: "ws" }).returning();
  await db.insert(locations).values({ orgId: o!.id, workspaceId: w!.id, name: "Loc", googleLocationId: locName });
});
beforeEach(() => {
  process.env.PUBSUB_AUDIENCE = AUD;
  process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL = SA;
});
afterAll(async () => {
  if (saved.aud === undefined) delete process.env.PUBSUB_AUDIENCE;
  else process.env.PUBSUB_AUDIENCE = saved.aud;
  if (saved.sa === undefined) delete process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
  else process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL = saved.sa;
  await sql.end();
});

describe("web Pub/Sub receiver", () => {
  it("canary: a valid token stores the notification and enqueues its job before answering 204", async () => {
    const id = `m-${uniq()}`;
    const res = await call(push(envelope(id), await token()));
    expect(res.status).toBe(204);
    const stored = await rows(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: "NEW_REVIEW", location_name: locName });
    expect(await jobs(stored[0]!.id)).toBe(1);
  });

  it("a redelivery of the same message id stores and enqueues nothing more", async () => {
    const id = `m-${uniq()}`;
    const t = await token();
    expect((await call(push(envelope(id), t))).status).toBe(204);
    expect((await call(push(envelope(id), t))).status).toBe(204);
    const stored = await rows(id);
    expect(stored).toHaveLength(1);
    expect(await jobs(stored[0]!.id)).toBe(1);
  });

  const rejected: [string, () => Promise<string | null>][] = [
    ["missing token", async () => null],
    ["wrong audience", () => token({ aud: "https://other.test/hook" })],
    ["wrong service account", () => token({ email: "evil@example.iam.gserviceaccount.com" })],
    ["unverified email", () => token({ verified: false })],
    ["expired", () => token({ exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["signed by another key", () => token({}, otherKey)],
  ];
  for (const [name, make] of rejected) {
    it(`${name}: 401 and nothing stored`, async () => {
      const id = `m-${uniq()}`;
      const res = await call(push(envelope(id), await make()));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await rows(id)).toHaveLength(0);
    });
  }

  it("answers 503 when the audience or service account is not configured, even with a good token", async () => {
    const t = await token();
    delete process.env.PUBSUB_AUDIENCE;
    expect((await call(push(envelope(`m-${uniq()}`), t))).status).toBe(503);
    process.env.PUBSUB_AUDIENCE = AUD;
    delete process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
    expect((await call(push(envelope(`m-${uniq()}`), t))).status).toBe(503);
  });

  it("acknowledges (204) and drops a body over the size limit, malformed JSON and an unknown location", async () => {
    const t = await token();
    expect((await call(push("x".repeat(70 * 1024), t))).status).toBe(204);
    expect((await call(push("{not json", t))).status).toBe(204);
    const id = `m-${uniq()}`;
    const e = envelope(id);
    e.message.data = Buffer.from(
      JSON.stringify({ notificationType: "NEW_REVIEW", locationName: "accounts/1/locations/0", reviewName: "accounts/1/locations/0/reviews/R" }),
    ).toString("base64");
    expect((await call(push(e, t))).status).toBe(204);
    expect(await rows(id)).toHaveLength(0);
  });

  it("answers 500 (so Pub/Sub retries) when the database fails after authentication", async () => {
    const broken = { select: () => { throw new Error("db down"); } } as unknown as typeof db;
    const res = await handlePubsubPush(push(envelope(`m-${uniq()}`), await token()), broken, jwks);
    expect(res.status).toBe(500);
  });
});
