import { describe, expect, it } from "vitest";
import { canResetTwoFactor, resetTwoFactorConfirm, resetTwoFactorDone } from "./two-factor-reset";

const member = { userId: "u2", twoFactorEnabled: true };

describe("canResetTwoFactor", () => {
  it("needs the permission, someone else, and two-factor on", () => {
    expect(canResetTwoFactor({ allowed: true, viewerUserId: "u1", member })).toBe(true);
    expect(canResetTwoFactor({ allowed: false, viewerUserId: "u1", member })).toBe(false);
    expect(canResetTwoFactor({ allowed: true, viewerUserId: "u2", member })).toBe(false);
    expect(
      canResetTwoFactor({ allowed: true, viewerUserId: "u1", member: { ...member, twoFactorEnabled: false } }),
    ).toBe(false);
  });
});

describe("copy", () => {
  it("names the person in the confirm and the result", () => {
    expect(resetTwoFactorConfirm("Priya")).toBe(
      "Reset two-factor authentication for Priya? They are signed out everywhere. Until they set up a new authenticator app at their next sign-in, their password alone signs them in.",
    );
    expect(resetTwoFactorDone("Priya")).toBe(
      "Two-factor reset. Priya sets it up again at their next sign-in.",
    );
  });
});
