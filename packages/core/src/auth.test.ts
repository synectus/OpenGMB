import { describe, expect, it } from "vitest";
import { AuthError, requireAuthenticatedUser, type SessionResult } from "./session";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AuthError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe("requireAuthenticatedUser", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const hours = (h: number) => new Date(now.getTime() + h * 3600_000);
  const make = (over: Partial<SessionResult["session"]> = {}, mfa = true): SessionResult => ({
    session: { createdAt: hours(-1), expiresAt: hours(1), ...over },
    user: { id: "u1", email: "a@b.test", twoFactorEnabled: mfa },
  });

  it("accepts a fresh MFA-enrolled session (canary)", () => {
    expect(requireAuthenticatedUser(make(), now)).toEqual({ userId: "u1", email: "a@b.test" });
  });
  it("UNAUTHENTICATED when no session", () => {
    expect(code(() => requireAuthenticatedUser(null, now))).toBe("UNAUTHENTICATED");
  });
  it("UNAUTHENTICATED when idle-expired", () => {
    expect(code(() => requireAuthenticatedUser(make({ expiresAt: hours(-0.01) }), now))).toBe(
      "UNAUTHENTICATED",
    );
  });
  it("UNAUTHENTICATED past the 12h absolute cap even if still sliding", () => {
    const s = make({ createdAt: hours(-12.01), expiresAt: hours(1.9) });
    expect(code(() => requireAuthenticatedUser(s, now))).toBe("UNAUTHENTICATED");
  });
  it("still valid just inside the cap", () => {
    expect(requireAuthenticatedUser(make({ createdAt: hours(-11.9), expiresAt: hours(1) }), now));
  });
  it("accepts ISO-string dates (JSON session)", () => {
    const s = make({ createdAt: hours(-1).toISOString(), expiresAt: hours(1).toISOString() });
    expect(requireAuthenticatedUser(s, now).userId).toBe("u1");
  });
  // Two-factor is optional (decision 2026-10-30) except for platform admins (PLATFORM_ADMIN_EMAILS).
  it("a non-admin without two-factor passes (canary: threw MFA_REQUIRED before 2026-10-30)", () => {
    expect(requireAuthenticatedUser(make({}, false), now, "boss@b.test")).toEqual({ userId: "u1", email: "a@b.test" });
    expect(requireAuthenticatedUser(make({}, false), now, undefined)).toEqual({ userId: "u1", email: "a@b.test" });
  });
  it("a platform admin with two-factor passes", () => {
    expect(requireAuthenticatedUser(make({}, true), now, "a@b.test").userId).toBe("u1");
  });
  it("an expired session is still UNAUTHENTICATED for a non-admin without two-factor", () => {
    expect(code(() => requireAuthenticatedUser(make({ expiresAt: hours(-1) }, false), now, undefined))).toBe("UNAUTHENTICATED");
  });
});
