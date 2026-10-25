import { describe, expect, it } from "vitest";
import { CoreError } from "../errors";
import type { GoogleClient } from "./client";
import { GoogleWritesDisabledError } from "./errors";
import { LiveGoogleClient } from "./live-client";
import { GOOGLE_CLIENT_METHOD_KINDS, ReadOnlyGoogleClient } from "./read-only-client";

const entries = Object.entries(GOOGLE_CLIENT_METHOD_KINDS);
const writes = entries.filter(([, k]) => k === "write").map(([n]) => n);
const reads = entries.filter(([, k]) => k === "read").map(([n]) => n);

function liveWithCountingFetch() {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  const live = new LiveGoogleClient({ getAccessToken: async () => "tok", fetch });
  return { live, urls };
}

describe("ReadOnlyGoogleClient", () => {
  it("classifies every method on the live client (canary: listAccounts read, updateReply write)", () => {
    const proto = Object.getOwnPropertyNames(LiveGoogleClient.prototype).filter(
      (n) => n !== "constructor" && !n.startsWith("_"),
    );
    const publicMethods = proto.filter((n) => n in GOOGLE_CLIENT_METHOD_KINDS);
    console.log(
      `GoogleClient methods: ${entries.length} (${writes.length} write / ${reads.length} read)`,
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(publicMethods.sort()).toEqual(entries.map(([n]) => n).sort());
    expect(GOOGLE_CLIENT_METHOD_KINDS.listAccounts).toBe("read");
    expect(GOOGLE_CLIENT_METHOD_KINDS.updateReply).toBe("write");
  });

  it("refuses every write without a single request to Google", async () => {
    const { live, urls } = liveWithCountingFetch();
    const c = new ReadOnlyGoogleClient(live) as unknown as Record<string, () => Promise<unknown>>;
    expect(writes.length).toBeGreaterThan(0);
    for (const name of writes) {
      const err = await c[name]!().catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(CoreError);
      expect(err, name).toBeInstanceOf(GoogleWritesDisabledError);
      expect((err as CoreError).code, name).toBe("NOT_CONFIGURED");
      expect((err as CoreError).message, name).toContain(name);
    }
    expect(urls).toEqual([]);
  });

  it("passes reads through to the inner client", async () => {
    const { live, urls } = liveWithCountingFetch();
    const c: GoogleClient = new ReadOnlyGoogleClient(live);
    await c.listAccounts();
    await c.getLocation("locations/1");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("mybusinessaccountmanagement.googleapis.com/v1/accounts");
  });
});
