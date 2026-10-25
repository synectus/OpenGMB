// Pure helpers for the sign-in, two-factor and invitation pages (canvas 6, approved 2026-10-18).
// Client-safe on purpose: it imports nothing from @opengmb/core, so client forms can use it.
import type { TimeFormat } from "./time-format";

/**
 * The TOTP secret in groups of 4, for reading. Joined, the groups are the secret unchanged: the
 * smoke test reads the page's only <code> element as the secret, so the page renders these as
 * adjacent spans with no text between them.
 */
export function secretGroups(secret: string): string[] {
  return secret.match(/.{1,4}/g) ?? [];
}

export const BACKUP_CODES_FILE = "opengmb-backup-codes.txt";

/** The body of the backup codes text file, also what "Copy codes" copies. */
export function backupCodesText(codes: string[]): string {
  return ["OpenGMB backup codes. Each code works once.", "", ...codes, ""].join("\n");
}

/** The roles an invitation can carry (DB check invitations_role_invitable). */
export type InvitableRole = "client_approver" | "client_viewer" | "manager";

/** Role box on /invite. Perks are drawn for the client viewer only (Invite.dc.html). */
export const INVITE_ROLES: Record<InvitableRole, { name: string; text: string; perks: string[] }> = {
  client_approver: {
    name: "Client approver",
    text: "You can approve content for your business.",
    perks: [],
  },
  client_viewer: {
    name: "Client viewer",
    text: "You can view reviews and content for your business.",
    perks: ["See reviews and replies", "See posts and profile changes", "No changes to Google"],
  },
  manager: {
    name: "Manager",
    text: "You can help manage Google Business Profiles across the whole organization.",
    perks: [],
  },
};

/** Role box for an organization invite (G9): the invitee starts and owns a new organization. */
export const ORG_INVITE_ROLE = {
  name: "Owner of a new organization",
  text: "You start your own organization. It is empty, and you can invite your team and clients to it.",
  perks: [] as string[],
};

export type InviteFacts = {
  email: string;
  inviterName: string;
  workspaceName: string | null;
  orgName: string;
  /** ISO instant. */
  expiresAt: string;
};

/** Where accepting puts the person: the client's workspace, or the whole organization. */
export const invitePlace = (i: InviteFacts): string => i.workspaceName ?? i.orgName;

export const inviteExpiry = (i: InviteFacts, tf: TimeFormat): string =>
  `Invitation expires ${tf.date(i.expiresAt)}.`;

export function inviteAccessLine(i: InviteFacts): string {
  return i.workspaceName
    ? `Accepting gives access only to ${i.workspaceName}. Two-factor authentication is required.`
    : "Two-factor authentication is required.";
}
