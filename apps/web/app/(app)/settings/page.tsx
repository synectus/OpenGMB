import { redirect } from "next/navigation";
import { roleHasPermission } from "@opengmb/core";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { settingsHome } from "../../../lib/settings-nav";

/** The sidebar's Settings link: go to the first settings page this role can open. */
export default async function SettingsIndex() {
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  redirect(settingsHome((p) => roleHasPermission(role, p)));
}
