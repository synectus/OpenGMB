import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DfsAccountError, DfsHttpError, DfsRetryableError } from "./errors";
import { liveDataForSeoTransport } from "./live-dataforseo";
import { rankSource } from "./source";

// A loopback fake DataForSEO: the test network guard allows loopback and refuses public hosts.
let server: Server;
let base: string;
let seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
let respond: (url: string, body: string) => { status: number; json: unknown };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const r = respond(req.url ?? "", body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
beforeEach(() => {
  seen = [];
});

const creds = async () => ({ login: "a@b.test", password: "pw-very-secret" });

describe("live DataForSEO transport: user_data", () => {
  it("Basic auth, returns ok with the balance and the day limit", async () => {
    respond = () => ({
      status: 200,
      json: { status_code: 20000, tasks: [{ status_code: 20000, result: [{ money: { balance: 42.5, limits: { day: { total: 10 } } } }] }] },
    });
    const t = liveDataForSeoTransport({ baseUrl: base, credentials: creds });
    expect(await t.checkCredentials!()).toMatchObject({ ok: true, balanceUsd: 42.5, dailyLimitUsd: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("/v3/appendix/user_data");
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("a@b.test:pw-very-secret").toString("base64")}`);
  });

  it("40100 is not ok and carries the code, never the password", async () => {
    respond = () => ({ status: 200, json: { status_code: 40100, status_message: "Authorization failed." } });
    const r = await liveDataForSeoTransport({ baseUrl: base, credentials: creds }).checkCredentials!();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("40100");
    expect(r.message).not.toContain("pw-very-secret");
  });

  it("HTTP 401 maps to not ok", async () => {
    respond = () => ({ status: 401, json: { status_code: 40100 } });
    const r = await liveDataForSeoTransport({ baseUrl: base, credentials: creds }).checkCredentials!();
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("401");
  });

  it("credentials are read on every call", async () => {
    respond = () => ({ status: 200, json: { status_code: 20000, tasks: [{ status_code: 20000, result: [{ money: { balance: 1 } }] }] } });
    let pw = "one";
    const t = liveDataForSeoTransport({ baseUrl: base, credentials: async () => ({ login: "l", password: pw }) });
    await t.checkCredentials!();
    pw = "two";
    await t.checkCredentials!();
    expect(seen[0]!.auth).not.toBe(seen[1]!.auth);
  });

  it("canary: a public address is refused by the test network guard", async () => {
    // An IP literal, so the guard records it at once; a hostname would need DNS first.
    const t = liveDataForSeoTransport({ baseUrl: "https://1.1.1.1", credentials: creds, timeoutMs: 5000 });
    await expect(t.checkCredentials!()).resolves.toMatchObject({ ok: false });
    expect((globalThis as { __blockedPublicConnects?: string[] }).__blockedPublicConnects?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("live DataForSEO transport: task_post and task_get", () => {
  const t = () => liveDataForSeoTransport({ baseUrl: base, credentials: creds });
  const item = { keyword: "k", location_coordinate: "1,2,13z", language_code: "en", device: "mobile" as const, depth: 20 };

  it("task_post: POST with a JSON array body and Basic auth; the body comes back unchanged", async () => {
    const answer = { version: "v", status_code: 20000, status_message: "Ok.", cost: 0.0006, tasks_count: 1, tasks: [{ id: "t1", status_code: 20100, status_message: "Task Created.", cost: 0.0006, result: null }] };
    respond = () => ({ status: 200, json: answer });
    expect(await t().taskPost([item])).toEqual(answer);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/v3/serp/google/maps/task_post");
    expect(JSON.parse(seen[0]!.body)).toEqual([item]);
    expect(seen[0]!.auth).toMatch(/^Basic /);
  });

  it("task_get: GET .../task_get/advanced/<id>, id URL-encoded", async () => {
    const answer = { status_code: 20000, tasks: [{ id: "a/b c", status_code: 40602, result: null }] };
    respond = () => ({ status: 200, json: answer });
    expect(await t().taskGet("a/b c")).toEqual(answer);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("/v3/serp/google/maps/task_get/advanced/a%2Fb%20c");
  });

  it("errors: HTTP 500 is DfsHttpError; HTTP 401/402 and account codes are DfsAccountError; 40202 is retryable", async () => {
    respond = () => ({ status: 500, json: {} });
    await expect(t().taskPost([item])).rejects.toBeInstanceOf(DfsHttpError);
    respond = () => ({ status: 402, json: { status_message: "Payment Required." } });
    await expect(t().taskPost([item])).rejects.toBeInstanceOf(DfsAccountError);
    respond = () => ({ status: 200, json: { status_code: 40210, status_message: "Insufficient funds" } });
    const err = await t().taskPost([item]).catch((e) => e);
    expect(err).toBeInstanceOf(DfsAccountError);
    expect(err.code).toBe(40210);
    expect(err.message).not.toContain("pw-very-secret");
    respond = () => ({ status: 200, json: { status_code: 40202, status_message: "rate" } });
    await expect(t().taskGet("x")).rejects.toBeInstanceOf(DfsRetryableError);
  });
});

describe("rankSource", () => {
  it("fixture without keys, live with both, sandbox with the sandbox base, half a key is no key", () => {
    expect(rankSource({})).toBe("fixture");
    expect(rankSource({ DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p" })).toBe("live");
    expect(
      rankSource({ DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p", DATAFORSEO_API_BASE: "https://sandbox.dataforseo.com" }),
    ).toBe("sandbox");
    expect(rankSource({ DATAFORSEO_LOGIN: "l" })).toBe("fixture");
    expect(rankSource({ DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p", DATAFORSEO_API_BASE: "https://evil.example" })).toBe("live");
  });
});
