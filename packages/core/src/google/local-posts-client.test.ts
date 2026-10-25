import { describe, expect, it } from "vitest";
import { createDb, organizations } from "@opengmb/db";
import type { GoogleLocalPost } from "./client";
import { GoogleApiError } from "./errors";
import { LiveGoogleClient, REVIEWS_BASE } from "./live-client";
import { MockGoogleClient } from "./mock-client";
import { ThrottledGoogleClient } from "./throttled-client";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db } = createDb(url);

const PARENT = "accounts/100000000000000000001/locations/200000000000000001";
const post: GoogleLocalPost = { topicType: "STANDARD", summary: "Hello" };
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("MockGoogleClient local posts", () => {
  it("create, list (paged), patch by updateMask, delete; unknown name is a 404", async () => {
    const m = new MockGoogleClient();
    const a = await m.createLocalPost(PARENT, post);
    await m.createLocalPost(PARENT, { ...post, summary: "Two" });
    expect(a.name).toMatch(new RegExp(`^${PARENT}/localPosts/`));
    expect(a.state).toBe("LIVE");
    const p1 = await m.listLocalPosts(PARENT, { pageSize: 1 });
    expect(p1.localPosts).toHaveLength(1);
    expect(p1.nextPageToken).toBe("1");
    expect(
      (await m.listLocalPosts(PARENT, { pageToken: "1", pageSize: 1 })).localPosts,
    ).toHaveLength(1);
    const u = await m.updateLocalPost(a.name!, { summary: "Changed" }, ["summary"]);
    expect(u.summary).toBe("Changed");
    await expect(m.updateLocalPost(a.name!, {}, [])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await m.deleteLocalPost(a.name!);
    expect((await m.listLocalPosts(PARENT)).localPosts).toHaveLength(1);
    await expect(m.deleteLocalPost(a.name!)).rejects.toBeInstanceOf(GoogleApiError);
    await expect(m.deleteLocalPost(a.name!)).rejects.toMatchObject({ status: 404 });
  });
});

describe("LiveGoogleClient local posts (fake fetch, no network)", () => {
  type Seen = { url: URL; init: RequestInit };
  function build(respond: (s: Seen) => Response) {
    const seen: Seen[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const s = { url: new URL(String(input)), init: init ?? {} };
      seen.push(s);
      return respond(s);
    }) as typeof fetch;
    return { seen, c: new LiveGoogleClient({ getAccessToken: async () => "t", fetch: fn }) };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("uses the documented methods and URLs", async () => {
    const name = `${PARENT}/localPosts/p1`;
    const { c, seen } = build((s) =>
      s.init.method === "DELETE" ? new Response("{}", { status: 200 }) : json(200, { name }),
    );
    await c.createLocalPost(PARENT, post);
    await c.updateLocalPost(name, { summary: "x" }, ["summary", "callToAction"]);
    await c.deleteLocalPost(name);
    await c.listLocalPosts(PARENT, { pageSize: 100, pageToken: "n" });
    expect(seen.map((s) => [s.init.method, s.url.pathname])).toEqual([
      ["POST", `/v4/${PARENT}/localPosts`],
      ["PATCH", `/v4/${name}`],
      ["DELETE", `/v4/${name}`],
      ["GET", `/v4/${PARENT}/localPosts`],
    ]);
    expect(REVIEWS_BASE).toBe("https://mybusiness.googleapis.com/v4");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(post);
    expect(seen[1]!.url.searchParams.get("updateMask")).toBe("summary,callToAction");
    expect([
      seen[3]!.url.searchParams.get("pageSize"),
      seen[3]!.url.searchParams.get("pageToken"),
    ]).toEqual(["100", "n"]);
  });

  it("list tolerates an empty response; bad names and empty masks never reach fetch", async () => {
    const { c, seen } = build(() => json(200, {}));
    expect((await c.listLocalPosts(PARENT)).localPosts).toEqual([]);
    seen.length = 0;
    await expect(c.createLocalPost("accounts/1/../2/locations/3", post)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(c.deleteLocalPost(`${PARENT}/localPosts/../x`)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(c.updateLocalPost(`${PARENT}/localPosts/p`, {}, [])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("ThrottledGoogleClient local post writes", () => {
  it("are idempotent per key; a different request on the same key is CONFLICT; list is a read", async () => {
    const mock = new MockGoogleClient();
    const g = new ThrottledGoogleClient(mock, db);
    const [org] = await db
      .insert(organizations)
      .values({ name: `o-${uniq()}` })
      .returning();
    const ctx = { orgId: org!.id, idempotencyKey: `post:${uniq()}:l:0` };
    const a = await g.createLocalPost(PARENT, post, ctx);
    expect(await g.createLocalPost(PARENT, { ...post }, ctx)).toEqual(a);
    expect(mock.calls.filter((c) => c.method === "createLocalPost")).toHaveLength(1);
    await expect(
      g.createLocalPost(PARENT, { ...post, summary: "Other" }, ctx),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const del = { orgId: org!.id, idempotencyKey: `postdelete:${uniq()}` };
    await g.deleteLocalPost(a.name!, del);
    await g.deleteLocalPost(a.name!, del);
    expect(mock.calls.filter((c) => c.method === "deleteLocalPost")).toHaveLength(1);
    expect((await g.listLocalPosts(PARENT)).localPosts).toEqual([]);
  });
});
