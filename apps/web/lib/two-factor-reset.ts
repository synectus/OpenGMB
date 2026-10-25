// Pure decisions for the owner-side "Reset two-factor" button (plan 6C). Client-safe.

/** `allowed` is roleHasPermission(viewerRole, "member:reset_two_factor"), computed on the server. */
export function canResetTwoFactor(i: {
  allowed: boolean;
  viewerUserId: string;
  member: { userId: string; twoFactorEnabled: boolean };
}): boolean {
  return i.allowed && i.member.userId !== i.viewerUserId && i.member.twoFactorEnabled;
}

export const resetTwoFactorConfirm = (name: string): string =>
  `Reset two-factor authentication for ${name}? They are signed out everywhere. Until they set up a new authenticator app at their next sign-in, their password alone signs them in.`;

export const resetTwoFactorDone = (name: string): string =>
  `Two-factor reset. ${name} sets it up again at their next sign-in.`;
