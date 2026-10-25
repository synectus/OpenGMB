import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { PgBoss } from "pg-boss";
import {
  apiTokens,
  createDb,
  memberships,
  reviews,
  webhookDeliveries,
  webhookSubscriptions,
} from "@opengmb/db";
import { WEBHOOK_DISABLE_AFTER_FAILURES, WEBHOOK_QUEUE } from "./config/webhooks";
import { encryptSecret } from "./crypto";
import { MockGoogleClient } from "./google/mock-client";
import { REVIEW_SYNC_QUEUE, processReviewSync } from "./reviews/sync";
import { makeKit, type Org } from "./testkit";
import { processWebhookDelivery, sendWebhookRequest } from "./webhooks/deliver";
import { sampleReviewCreatedPayload } from "./webhooks/payload";
import { generateWebhookSecret, verifyWebhook } from "./webhooks/signing";
import { subscribeWebhook } from "./webhooks/subscriptions";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
const boss = new PgBoss(url);

// A self-signed certificate for 127.0.0.1, generated per run (nothing secret is committed).
let key = "";
let cert = "";
beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  const dir = mkdtempSync(join(tmpdir(), "g7-cert-"));
  writeFileSync(
    join(dir, "o.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-config", join(dir, "o.cnf")], { stdio: "ignore" });
  key = readFileSync(join(dir, "k.pem"), "utf8");
  cert = readFileSync(join(dir, "c.pem"), "utf8");
  await boss.start();
  await boss.createQueue(WEBHOOK_QUEUE);
  await boss.createQueue(REVIEW_SYNC_QUEUE);
  await boss.stop();
}, 60_000);
afterAll(async () => {
  await kit.deactivateAll();
  await client.end();
});

type Seen = { headers: IncomingMessage["headers"]; body: string };
type Receiver = { port: number; seen: Seen[]; close: () => Promise<void> };
async function receiver(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<Receiver> {
  const seen: Seen[] = [];
  const server: Server = createServer({ key, cert }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sockets = new Set<TLSSocket>();
  server.on("secureConnection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return {
    port: (server.address() as { port: number }).port,
    seen,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const testPolicy = { allowAddress: (ip: string) => ip === "127.0.0.1", allowPort: () => true };
const answer = (status: number) => (_q: IncomingMessage, res: ServerResponse) => {
  res.statusCode = status;
  res.end("ok");
};

async function setup(urlOf: string | ((port: number) => string), r?: Receiver, sub: Partial<typeof webhookSubscriptions.$inferInsert> = {}) {
  const org = await kit.makeOrg();
  const secret = generateWebhookSecret();
  const [s] = await db
    .insert(webhookSubscriptions)
    .values({
      orgId: org.orgId,
      url: typeof urlOf === "function" ? urlOf(r!.port) : urlOf,
      events: ["review.created"],
      secretEnc: encryptSecret(secret),
      createdByUserId: org.ownerId,
      ...sub,
    })
    .returning();
  const delivery = await newDelivery(org, s!.id);
  return { org, sub: s!, secret, deliveryId: delivery };
}
async function newDelivery(org: Org, subscriptionId: string) {
  const [d] = await db
    .insert(webhookDeliveries)
    .values({
      orgId: org.orgId,
      workspaceId: org.a,
      subscriptionId,
      eventType: "review.created",
      entityId: crypto.randomUUID(),
      payload: sampleReviewCreatedPayload({ id: org.a, name: "A" }),
    })
    .returning({ id: webhookDeliveries.id });
  return d!.id;
}
const local = (port: number) => `https://127.0.0.1:${port}/hook`;
const getDelivery = async (id: string) =>
  (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)))[0]!;
const getSub = async (id: string) =>
  (await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)))[0]!;
const run = (id: string, extra: Record<string, unknown> = {}) =>
  processWebhookDelivery(db, id, { policy: testPolicy, ca: cert, ...extra });

describe("processWebhookDelivery", () => {
  it("200: delivered, signed per Standard Webhooks, failures reset", async () => {
    const r = await receiver(answer(200));
    try {
      const { sub, secret, deliveryId } = await setup(local, r, { consecutiveFailures: 3 });
      expect(await run(deliveryId)).toBe("delivered");
      const d = await getDelivery(deliveryId);
      expect(d).toMatchObject({ status: "delivered", attempts: 1, lastStatusCode: 200 });
      expect((await getSub(sub.id)).consecutiveFailures).toBe(0);
      expect(r.seen).toHaveLength(1);
      const h = r.seen[0]!.headers;
      expect(h["webhook-id"]).toBe(deliveryId);
      expect(h["content-type"]).toBe("application/json");
      expect(h["user-agent"]).toBe("OpenGMB-Webhooks/1");
      expect(
        verifyWebhook({
          id: String(h["webhook-id"]),
          timestamp: Number(h["webhook-timestamp"]),
          body: r.seen[0]!.body,
          secret,
          signature: String(h["webhook-signature"]),
        }),
      ).toBe(true);
      expect(await run(deliveryId)).toBeNull(); // settled: a no-op
      expect(r.seen).toHaveLength(1);
    } finally {
      await r.close();
    }
  });

  it("interop: the official Standard Webhooks library verifies our delivered request, and rejects a tampered body", async () => {
    const r = await receiver(answer(200));
    try {
      const { secret, deliveryId } = await setup(local, r);
      expect(await run(deliveryId)).toBe("delivered");
      expect(r.seen).toHaveLength(1); // canary: there is a real request to verify
      const { headers, body } = r.seen[0]!;
      const wanted = ["webhook-id", "webhook-timestamp", "webhook-signature"];
      const sent = Object.fromEntries(wanted.map((k) => [k, String(headers[k])]));
      const official = new Webhook(secret);
      const parsed = official.verify(body, sent) as { type?: string };
      expect(parsed).toBeTruthy();
      expect(() => official.verify(body.replace("review.created", "review.deleted"), sent)).toThrow();
      expect(() => official.verify(body + " ", sent)).toThrow();
      expect(() => new Webhook(generateWebhookSecret()).verify(body, sent)).toThrow();
    } finally {
      await r.close();
    }
  });

  it("500 while not final throws and stays pending; the final attempt ends failed and counts", async () => {
    const r = await receiver(answer(500));
    try {
      const { sub, deliveryId } = await setup(local, r);
      await expect(run(deliveryId)).rejects.toThrow(/retried/);
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "pending", attempts: 1, lastStatusCode: 500, lastError: "http_500" });
      expect(await run(deliveryId, { isFinalAttempt: true })).toBe("failed");
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "failed", attempts: 2 });
      expect((await getSub(sub.id)).consecutiveFailures).toBe(1);
    } finally {
      await r.close();
    }
  });

  it("the 20th failure in a row disables the subscription with reason failing and one audit row", async () => {
    const r = await receiver(answer(500));
    try {
      const { org, sub, deliveryId } = await setup(local, r, { consecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES - 1 });
      expect(await run(deliveryId, { isFinalAttempt: true })).toBe("failed");
      expect(await getSub(sub.id)).toMatchObject({ status: "disabled", disabledReason: "failing" });
      const audit = await kit.auditRows(org.orgId, "webhook.disabled");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: "system" });
    } finally {
      await r.close();
    }
  });

  it("410 disables the subscription with reason gone and does not throw", async () => {
    const r = await receiver(answer(410));
    try {
      const { sub, deliveryId } = await setup(local, r);
      expect(await run(deliveryId)).toBe("failed");
      expect(await getSub(sub.id)).toMatchObject({ status: "disabled", disabledReason: "gone" });
      expect((await getDelivery(deliveryId)).lastStatusCode).toBe(410);
    } finally {
      await r.close();
    }
  });

  it("400 ends failed at once, with no retry", async () => {
    const r = await receiver(answer(400));
    try {
      const { sub, deliveryId } = await setup(local, r);
      expect(await run(deliveryId)).toBe("failed");
      expect(r.seen).toHaveLength(1);
      expect((await getSub(sub.id)).status).toBe("active");
    } finally {
      await r.close();
    }
  });

  it("302 is not followed: one request, delivery failed", async () => {
    const target = await receiver(answer(200));
    const r = await receiver((_q, res) => {
      res.statusCode = 302;
      res.setHeader("location", local(target.port));
      res.end();
    });
    try {
      const { deliveryId } = await setup(local, r);
      expect(await run(deliveryId)).toBe("failed");
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "failed", lastStatusCode: 302 });
      expect(r.seen).toHaveLength(1);
      expect(target.seen).toHaveLength(0);
    } finally {
      await r.close();
      await target.close();
    }
  });

  it("a receiver that never answers times out and is retried", async () => {
    const r = await receiver(() => undefined);
    try {
      const { deliveryId } = await setup(local, r);
      await expect(run(deliveryId, { timeoutMs: 300 })).rejects.toThrow(/retried/);
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "pending", lastError: "timeout" });
    } finally {
      await r.close();
    }
  });

  it("reads at most 4 KB of a 1 MB response", async () => {
    const r = await receiver((_q, res) => {
      res.statusCode = 200;
      res.end(Buffer.alloc(1024 * 1024, 97));
    });
    try {
      const out = await sendWebhookRequest(new URL(local(r.port)), { headers: { "content-type": "application/json" }, body: "{}" }, { policy: testPolicy, ca: cert });
      expect(out).toMatchObject({ kind: "response", statusCode: 200, bytesRead: 4096, truncated: true });
    } finally {
      await r.close();
    }
  });

  it("canary: with the default policy a loopback receiver gets 0 requests and the delivery fails as blocked_address", async () => {
    const r = await receiver(answer(200));
    try {
      const { deliveryId } = await setup(local, r);
      expect(await processWebhookDelivery(db, deliveryId, { ca: cert })).toBe("failed");
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "failed", lastError: "blocked_address" });
      expect(r.seen).toHaveLength(0);
    } finally {
      await r.close();
    }
  });

  it("the lookup guard is wired into the connection: a name that validates as public but connects to loopback is refused (DNS rebinding)", async () => {
    const r = await receiver(answer(200));
    try {
      // First answer (URL check) is public, second answer (the connection's own lookup) is loopback.
      const publicAnswer = async () => [{ address: "3.3.3.3", family: 4 }];
      const rebound = async () => [{ address: "127.0.0.1", family: 4 }];
      const { deliveryId } = await setup("https://rebind.example.com/hook");
      const out = await processWebhookDelivery(db, deliveryId, { resolve: publicAnswer, lookupResolve: rebound, ca: cert });
      expect(out).toBe("failed");
      expect(await getDelivery(deliveryId)).toMatchObject({ status: "failed", lastError: "blocked_address" });
      expect(r.seen).toHaveLength(0);
    } finally {
      await r.close();
    }
  });

  it("a revoked creating token: skipped, subscription disabled, nothing sent", async () => {
    const r = await receiver(answer(200));
    try {
      const org = await kit.makeOrg();
      const [tok] = await db
        .insert(apiTokens)
        .values({ orgId: org.orgId, userId: org.ownerId, name: "t", tokenHash: `h-${crypto.randomUUID()}`, revokedAt: new Date() })
        .returning();
      const [s] = await db
        .insert(webhookSubscriptions)
        .values({ orgId: org.orgId, url: local(r.port), events: ["review.created"], secretEnc: encryptSecret("x"), createdByUserId: org.ownerId, apiTokenId: tok!.id })
        .returning();
      const id = await newDelivery(org, s!.id);
      expect(await run(id)).toBe("skipped");
      expect(await getDelivery(id)).toMatchObject({ status: "skipped" });
      expect(await getSub(s!.id)).toMatchObject({ status: "disabled", disabledReason: "token_revoked" });
      expect(r.seen).toHaveLength(0);
    } finally {
      await r.close();
    }
  });

  it("a removed creator: skipped, subscription disabled with creator_removed", async () => {
    const r = await receiver(answer(200));
    try {
      const { org, sub, deliveryId } = await setup(local, r);
      await db.delete(memberships).where(eq(memberships.userId, org.ownerId));
      expect(await run(deliveryId)).toBe("skipped");
      expect(await getSub(sub.id)).toMatchObject({ status: "disabled", disabledReason: "creator_removed" });
      expect(r.seen).toHaveLength(0);
    } finally {
      await r.close();
    }
  });

  it("a delivery whose subscription was turned off is skipped without sending", async () => {
    const r = await receiver(answer(200));
    try {
      const { deliveryId } = await setup(local, r, { status: "disabled", disabledReason: "manual" });
      expect(await run(deliveryId)).toBe("skipped");
      expect(r.seen).toHaveLength(0);
    } finally {
      await r.close();
    }
  });
});

describe("G7a done-when", () => {
  it("subscribe, sync twice with the mock Google client, deliver: exactly one signed POST", async () => {
    const r = await receiver(answer(200));
    try {
      const org = await kit.makeOrg();
      const loc = await org.mkLoc(org.a);
      const created = await db.transaction((tx) =>
        subscribeWebhook(tx, org.owner, { url: local(r.port) }, async () => undefined, { policy: testPolicy }),
      );
      const syncOnce = async () => {
        const out = await kit.run<{ syncs: { syncId: string }[] }>(org.owner, "reviews.sync", { workspaceId: org.a, locationIds: [loc.row.id] });
        return processReviewSync(db, out.syncs[0]!.syncId, { client: mock });
      };
      const deliverPending = async () => {
        const pending = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, created.subscription.id));
        for (const d of pending) await run(d.id);
      };

      await syncOnce(); // first sync of the location: an import, delivers nothing
      await deliverPending();
      expect(r.seen).toHaveLength(0);

      const name = mock.addReview(loc.row.googleAccountName!, loc.row.googleLocationId!, { starRating: "FIVE", comment: "Done-when review", createTime: new Date().toISOString() });
      await syncOnce();
      await deliverPending();
      expect(r.seen).toHaveLength(1);

      const [rev] = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.googleReviewName, name));
      const body = JSON.parse(r.seen[0]!.body) as { type: string; data: { review: { id: string } } };
      expect(body.type).toBe("review.created");
      expect(body.data.review.id).toBe(rev!.id);
      const h = r.seen[0]!.headers;
      expect(verifyWebhook({ id: String(h["webhook-id"]), timestamp: Number(h["webhook-timestamp"]), body: r.seen[0]!.body, secret: created.secret, signature: String(h["webhook-signature"]) })).toBe(true);
      const delivered = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, created.subscription.id));
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.status).toBe("delivered");

      await syncOnce(); // nothing changed upstream
      await deliverPending();
      expect(r.seen).toHaveLength(1);
      console.log("1 subscription, 3 syncs, 1 delivery");
    } finally {
      await r.close();
    }
  }, 30_000);
});
