import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  googleNotifications,
  locations,
  memberships,
  organizations,
  pushSubscriptions,
  users,
  workspaces,
} from "@opengmb/db";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a) } }));

import { processGoogleNotification } from "./google-notification";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeEach(() => {
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
  vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
  vi.stubEnv("VAPID_SUBJECT", "mailto:ops@example.test");
});

async function world() {
  const [org] = await db.insert(organizations).values({ name: `org-${uniq()}` }).returning();
  const [ws] = await db.insert(workspaces).values({ orgId: org!.id, name: `ws-${uniq()}` }).returning();
  const [loc] = await db
    .insert(locations)
    .values({ orgId: org!.id, workspaceId: ws!.id, name: "Houston Clinic - Downtown" })
    .returning();
  const id = `u-${uniq()}`;
  await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
  await db.insert(memberships).values({ orgId: org!.id, userId: id, role: "owner", workspaceId: null });
  const endpoint = `https://fcm.googleapis.com/fcm/send/${uniq()}`;
  await db.insert(pushSubscriptions).values({ orgId: org!.id, userId: id, endpoint, p256dh: "p", auth: "a" });
  const gn = async (type: "NEW_REVIEW" | "UPDATED_REVIEW") => {
    const [r] = await db
      .insert(googleNotifications)
      .values({
        orgId: org!.id,
        locationId: loc!.id,
        pubsubMessageId: `m-${uniq()}`,
        type,
        resourceName: "accounts/1/locations/2/reviews/3",
        locationName: "locations/2",
        payload: { notificationType: type, comment: "private patient text" },
      })
      .returning();
    return r!.id;
  };
  return { gn, endpoint };
}

describe("push from the Google notification pipeline", () => {
  it("a new review produces a push to the stored device, without review text", async () => {
    const w = await world();
    await processGoogleNotification(db, await w.gn("NEW_REVIEW"));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [sub, body] = sendNotification.mock.calls[0]!;
    expect((sub as { endpoint: string }).endpoint).toBe(w.endpoint);
    expect(JSON.parse(body as string)).toEqual({
      title: "New review at Houston Clinic - Downtown",
      url: "/reviews",
      tag: "google.new_review",
    });
    expect(body).not.toContain("private patient text");
  });

  it("an updated review stays in-app only", async () => {
    const w = await world();
    await processGoogleNotification(db, await w.gn("UPDATED_REVIEW"));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("a re-run of the same notification does not push twice", async () => {
    const w = await world();
    const id = await w.gn("NEW_REVIEW");
    await processGoogleNotification(db, id);
    await processGoogleNotification(db, id);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
