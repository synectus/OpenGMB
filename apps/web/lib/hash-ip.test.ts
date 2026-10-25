import { describe, expect, it } from "vitest";
import { hashIp } from "./hash-ip";

describe("hashIp", () => {
  it("is deterministic per secret, never contains the address and differs between addresses", () => {
    const a = hashIp("203.0.113.9", "s1");
    expect(a).toBe(hashIp("203.0.113.9", "s1"));
    expect(a).not.toContain("203");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(hashIp("203.0.113.10", "s1")).not.toBe(a);
    expect(hashIp("203.0.113.9", "s2")).not.toBe(a);
  });
  it("falls back to a random salt without throwing when no secret is set", () => {
    expect(hashIp("203.0.113.9", "")).toMatch(/^[0-9a-f]{32}$/);
  });
});
