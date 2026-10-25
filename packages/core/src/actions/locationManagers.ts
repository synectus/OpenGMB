import { z } from "zod";
import { clientForLocation, googleNames, loadLocation } from "../locationOps/access";
import { defineAction } from "../registry";

const ROLES = ["PRIMARY_OWNER", "OWNER", "MANAGER", "SITE_MANAGER"] as const;

export const locationManagersList = defineAction({
  name: "locationManagers.list",
  description:
    "Who manages a location on Google, read live (Account Management API locations.admins.list, outside any transaction). Each manager has a display name (an invited person who has not accepted yet shows the invited email), a role (PRIMARY_OWNER, OWNER, MANAGER, SITE_MANAGER; anything else is returned as OTHER) and pendingInvitation. Read only: OpenGMB does not invite, change or remove managers. Spends a Google call, so call it only when the list is wanted. Whether Google includes managers inherited from the account is not documented.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    managers: z.array(
      z.object({
        name: z.string(),
        role: z.enum([...ROLES, "OTHER"]),
        pendingInvitation: z.boolean(),
      }),
    ),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const client = await clientForLocation(db, actor, loc);
    const { locationName } = googleNames(loc);
    const { admins } = await client.listLocationAdmins(locationName);
    return {
      managers: admins.map((a) => ({
        name: a.admin?.trim() || "Unnamed",
        role: ROLES.find((r) => r === a.role) ?? ("OTHER" as const),
        pendingInvitation: a.pendingInvitation === true,
      })),
    };
  },
});
