import { describe, expect, it } from "vitest";
import { isKnownClientHost, parseConsentChoice, redirectHostOf } from "./oauth-consent";

const orgs = [
  { orgId: "o1", name: "Agency", readOnly: false },
  { orgId: "o2", name: "Client portal", readOnly: true },
];

describe("redirectHostOf", () => {
  it("canary: host with port", () => expect(redirectHostOf("http://127.0.0.1:53682/callback")).toBe("127.0.0.1:53682"));
  it("null for missing or bad input", () => {
    expect(redirectHostOf(null)).toBeNull();
    expect(redirectHostOf("nope")).toBeNull();
  });
});

describe("isKnownClientHost", () => {
  it("claude.ai, chatgpt.com and loopback are known (port ignored)", () => {
    for (const h of ["claude.ai", "chatgpt.com", "localhost:6274", "127.0.0.1:53682", "[::1]:9000"]) expect(isKnownClientHost(h), h).toBe(true);
  });
  it("look-alikes are not", () => {
    for (const h of ["claude.ai.evil.test", "evil.test", "chatgpt.com.example"]) expect(isKnownClientHost(h), h).toBe(false);
  });
});

describe("parseConsentChoice", () => {
  it("one org: it is used without asking", () => {
    expect(parseConsentChoice({ access: "write", fullAutonomy: "on" }, [orgs[0]!])).toEqual({ orgId: "o1", access: "write", fullAutonomy: true });
  });
  it("several orgs: the chosen one must be in the list", () => {
    expect(parseConsentChoice({ orgId: "o9", access: "read" }, orgs)).toEqual({ error: "account" });
    expect(parseConsentChoice({ orgId: "o1", access: "read" }, orgs)).toEqual({ orgId: "o1", access: "read", fullAutonomy: false });
  });
  it("a read-only org is forced to read, and autonomy is off without write", () => {
    expect(parseConsentChoice({ orgId: "o2", access: "write", fullAutonomy: "on" }, orgs)).toEqual({ orgId: "o2", access: "read", fullAutonomy: false });
    expect(parseConsentChoice({ orgId: "o1", access: "read", fullAutonomy: "on" }, orgs)).toEqual({ orgId: "o1", access: "read", fullAutonomy: false });
  });
  it("no orgs at all is an error", () => expect(parseConsentChoice({ access: "read" }, [])).toEqual({ error: "account" }));
});
