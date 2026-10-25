import { describe, expect, it } from "vitest";
import type { GoogleClient } from "./client";
import { GoogleApiError, GoogleRateLimitError } from "./errors";
import { MockGoogleClient } from "./mock-client";

const client: GoogleClient = new MockGoogleClient();

describe("MockGoogleClient via the GoogleClient interface", () => {
  it("lists the fixture accounts and locations", async () => {
    const { accounts } = await client.listAccounts();
    expect(accounts).toHaveLength(2);
    const perAccount = await Promise.all(accounts.map((a) => client.listLocations(a.name)));
    const total = perAccount.reduce((n, r) => n + r.locations.length, 0);
    console.log(`google fixtures: ${accounts.length} accounts, ${total} locations`);
    expect(total).toBe(4);
    expect(perAccount.map((r) => r.locations.length)).toEqual([2, 2]);
  });

  it("applies readMask and getLocation, and 404s unknown names", async () => {
    const [first] = (await client.listLocations("accounts/100000000000000000001")).locations;
    const masked = await client.getLocation(first!.name, { readMask: "title,websiteUri" });
    expect(Object.keys(masked).sort()).toEqual(["name", "title", "websiteUri"]);
    await expect(client.getLocation("locations/0")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.listLocations("accounts/0")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("MockGoogleClient writes and failure injection", () => {
  const LOC = "accounts/100000000000000000001";

  it("updateLocation applies only masked fields, clears masked-but-absent ones, returns the location", async () => {
    const m = new MockGoogleClient();
    const [first] = (await m.listLocations(LOC)).locations;
    const before = await m.getLocation(first!.name);
    const out = await m.updateLocation(
      first!.name,
      { title: "Renamed", websiteUri: "https://ignored.example" },
      ["title", "storeCode"],
    );
    expect(out.title).toBe("Renamed");
    expect(out.storeCode).toBeUndefined();
    expect(out.websiteUri).toBe(before.websiteUri);
    expect(await m.getLocation(first!.name)).toEqual(out);
    // nested path
    const nested = await m.updateLocation(
      first!.name,
      { phoneNumbers: { primaryPhone: "+1 555 0100" } },
      ["phoneNumbers.primaryPhone"],
    );
    expect(nested.phoneNumbers?.primaryPhone).toBe("+1 555 0100");
  });

  it("does not leak writes between instances or into the fixtures", async () => {
    const a = new MockGoogleClient();
    const [first] = (await a.listLocations(LOC)).locations;
    await a.updateLocation(first!.name, { title: "Only A" }, ["title"]);
    expect((await new MockGoogleClient().getLocation(first!.name)).title).not.toBe("Only A");
  });

  it("validates mask and target", async () => {
    const m = new MockGoogleClient();
    const [first] = (await m.listLocations(LOC)).locations;
    await expect(m.updateLocation(first!.name, {}, [])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(m.updateLocation(first!.name, { name: "x" }, ["name"])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(m.updateLocation("locations/0", { title: "x" }, ["title"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rateLimitNext fails N calls with 429 (and Retry-After), counting every call", async () => {
    const m = new MockGoogleClient();
    m.rateLimitNext(2, 3);
    const e1 = await m.listAccounts().catch((x) => x);
    expect(e1).toBeInstanceOf(GoogleRateLimitError);
    expect(e1.retryAfterMs).toBe(3000);
    await expect(m.listAccounts()).rejects.toBeInstanceOf(GoogleRateLimitError);
    await expect(m.listAccounts()).resolves.toBeTruthy();
    expect(m.callCount).toBe(3);
    expect(m.calls.map((c) => c.method)).toEqual(["listAccounts", "listAccounts", "listAccounts"]);
  });
});

describe("MockGoogleClient listCategories filter (mirrors Google)", () => {
  const list = (filter: string) =>
    new MockGoogleClient().listCategories({
      regionCode: "US",
      languageCode: "en",
      view: "BASIC",
      filter,
    });

  it("accepts a quoted multi-word value", async () => {
    const r = await list('displayName="pain control"');
    expect(r.categories.map((c) => c.displayName)).toEqual(["Pain control clinic"]);
  });

  it("accepts a bare single word", async () => {
    const r = await list("displayName=pain");
    expect(r.categories.length).toBeGreaterThan(0);
  });

  it("rejects a bare value with whitespace like Google: 400 INVALID_ARGUMENT", async () => {
    const e = await list("displayName=pain control").catch((x) => x);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e.status).toBe(400);
    expect(e.body).toEqual({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              { field: "filter", description: "displayName is the only supported filter" },
            ],
          },
        ],
      },
    });
  });
});
