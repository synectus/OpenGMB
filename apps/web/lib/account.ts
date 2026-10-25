// Pure decisions for /account (canvas 6, D18). Client-safe: nothing from @opengmb/core.

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  client_approver: "Client approver",
  client_viewer: "Client viewer",
};
export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? role;

export const isClientRole = (role: string): boolean =>
  role === "client_approver" || role === "client_viewer";

/** Plan assumption: the boards show 2 as "low"; warn from 3 so there is time to act. */
export const LOW_BACKUP_CODES = 3;
export const isLowBackupCodes = (left: number): boolean => left <= LOW_BACKUP_CODES;

export const backupCodesLine = (left: number, total: number): string =>
  `Backup codes: ${left} of ${total} left`;

const codes = (n: number) => `${n} backup ${n === 1 ? "code" : "codes"}`;
export const lowCodesHeadline = (left: number): string => `${codes(left)} left.`;
export const verifyLowCodesText = (left: number): string =>
  `You have ${codes(left)} left. Make new ones in your account.`;

export function newPasswordProblem(next: string, repeat: string): string | null {
  return next === repeat ? null : "Passwords do not match";
}

/** Better-Auth error -> where to show it. Only a wrong current password is reworded. */
export function passwordChangeError(e: { code?: string; message?: string }): {
  field: "current" | "form";
  message: string;
} {
  if (e.code === "INVALID_PASSWORD") {
    return { field: "current", message: "Current password is incorrect" };
  }
  return { field: "form", message: e.message ?? "Could not change your password, please try again" };
}

export function organizationLine(i: { role: string; orgName: string; workspaceNames: string[] }): string {
  const where = isClientRole(i.role) ? i.workspaceNames.join(", ") : i.orgName;
  return `${where} · ${roleLabel(i.role)}`;
}
