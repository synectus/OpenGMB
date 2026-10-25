import { describe, expect, it } from "vitest";
import {
  BLOCKED_V4,
  BLOCKED_V6,
  guardedLookup,
  isBlockedAddress,
  validateWebhookUrl,
} from "./webhooks/ssrf";

const resolvesTo = (...ips: string[]) => async () =>
  ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

// One representative address inside every blocked range, in list order.
const V4_SAMPLES = [
  "0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5",
  "192.0.0.9", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1",
  "203.0.113.1", "224.0.0.1", "240.0.0.1",
];
const V6_SAMPLES = [
  "::", "::1", "::10.0.0.1", "fd00::1", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "100::1",
  "2001::1", "2002:0a00:0001::1", "64:ff9b:1::1",
];

describe("canary and denominator", () => {
  it("canary: loopback is blocked", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
  });
  it("has one sample per listed range", () => {
    console.log(`SSRF ranges checked: ${BLOCKED_V4.length} IPv4 + ${BLOCKED_V6.length} IPv6`);
    expect(V4_SAMPLES.length).toBe(BLOCKED_V4.length);
    expect(V6_SAMPLES.length).toBe(BLOCKED_V6.length);
    for (const ip of V4_SAMPLES) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of V6_SAMPLES) expect(isBlockedAddress(ip), ip).toBe(true);
  });
  it("blocks IPv4-mapped and NAT64 forms of private addresses, allows those of public ones", () => {
    for (const ip of ["::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "64:ff9b::7f00:1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress("::ffff:3.3.3.3")).toBe(false);
    expect(isBlockedAddress("64:ff9b::303:303")).toBe(false);
  });
  it("allows ordinary public addresses", () => {
    for (const ip of ["3.3.3.3", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "172.32.0.1", "100.128.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("validateWebhookUrl", () => {
  const bad = [
    "http://hooks.example.com/x",
    "ftp://hooks.example.com/x",
    "https://u:p@hooks.example.com/x",
    "https://u@hooks.example.com/x",
    "https://hooks.example.com:8443/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://10.1.2.3/x",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/x",
    "https://[fd00::1]/x",
    "https://[::ffff:10.0.0.1]/x",
    "https://[64:ff9b::a00:1]/x",
    "https://0.0.0.0/x",
    "https://localhost/x",
    "https://foo.localhost/x",
    "https://2130706433/x",
    "https://0x7f.1/x",
    "not a url",
  ];
  for (const raw of bad) {
    it(`rejects ${raw}`, async () => {
      // The resolver would hand back a public address, so only the URL itself can fail.
      const r = await validateWebhookUrl(raw, { resolve: resolvesTo("3.3.3.3") });
      expect(r.ok).toBe(false);
    });
  }

  it("accepts a public https URL", async () => {
    const r = await validateWebhookUrl("https://hooks.zapier.com/hooks/standard/1/2/", {
      resolve: resolvesTo("3.3.3.3"),
    });
    expect(r).toMatchObject({ ok: true });
  });

  it("rejects a name that resolves to a private address, or to a mix", async () => {
    const one = await validateWebhookUrl("https://evil.example.com/x", { resolve: resolvesTo("10.0.0.5") });
    expect(one).toEqual({ ok: false, reason: "blocked_address" });
    const mix = await validateWebhookUrl("https://evil.example.com/x", { resolve: resolvesTo("3.3.3.3", "127.0.0.1") });
    expect(mix).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("rejects a name that does not resolve", async () => {
    const r = await validateWebhookUrl("https://nope.example.com/x", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r).toEqual({ ok: false, reason: "dns" });
  });

  it("a test policy can relax the port and address, nothing else", async () => {
    const policy = { allowAddress: (ip: string) => ip === "127.0.0.1", allowPort: () => true };
    expect(await validateWebhookUrl("https://127.0.0.1:4443/x", { policy })).toMatchObject({ ok: true });
    expect(await validateWebhookUrl("http://127.0.0.1:4443/x", { policy })).toMatchObject({ ok: false });
    expect(await validateWebhookUrl("https://u:p@127.0.0.1:4443/x", { policy })).toMatchObject({ ok: false });
    expect(await validateWebhookUrl("https://10.0.0.1:4443/x", { policy })).toMatchObject({ ok: false });
  });
});

describe("guardedLookup", () => {
  const run = (resolve: ReturnType<typeof resolvesTo>, all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; out: unknown }>((done) =>
      guardedLookup(undefined, resolve)("h.example.com", { all }, (err: unknown, a: unknown, f?: unknown) =>
        done({ err: err as NodeJS.ErrnoException | null, out: all ? a : [a, f] }),
      ),
    );

  it("errors with WEBHOOK_BLOCKED_ADDRESS when any resolved address is private (DNS rebinding)", async () => {
    const r = await run(resolvesTo("3.3.3.3", "10.0.0.5"), true);
    expect(r.err?.code).toBe("WEBHOOK_BLOCKED_ADDRESS");
    const single = await run(resolvesTo("3.3.3.3", "169.254.169.254"), false);
    expect(single.err?.code).toBe("WEBHOOK_BLOCKED_ADDRESS");
  });

  it("returns the addresses when all are public", async () => {
    const all = await run(resolvesTo("3.3.3.3"), true);
    expect(all.err).toBeNull();
    expect(all.out).toEqual([{ address: "3.3.3.3", family: 4 }]);
    const one = await run(resolvesTo("3.3.3.3"), false);
    expect(one.out).toEqual(["3.3.3.3", 4]);
  });

  it("passes a resolver failure through", async () => {
    const r = await new Promise<NodeJS.ErrnoException | null>((done) =>
      guardedLookup(undefined, async () => {
        throw new Error("boom");
      })("h", { all: true }, (err: unknown) => done(err as NodeJS.ErrnoException)),
    );
    expect(r).toBeTruthy();
  });
});
