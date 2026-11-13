import { z } from "zod";
import { assertNotApiTokenCaller } from "../apiTokens";
import { disconnectConnectedApp, listConnectedApps, updateConnectedApp } from "../oauth/connections";
import { defineAction } from "../registry";

const appOut = z.object({
  id: z.string(),
  name: z.string(),
  redirectHost: z.string().nullable(),
  ownerUserId: z.string(),
  ownerEmail: z.string(),
  access: z.enum(["read", "write"]),
  fullAutonomy: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

export const connectedAppsList = defineAction({
  name: "connectedApps.list",
  description:
    "List apps connected to the caller's organization over OAuth (claude.ai, ChatGPT and other connectors), newest first: app name, the site it returns to, owner, access (read or write), whether it may publish without approval, and last use. Members see their own; owners and admins see everyone's. Ordinary API tokens are listed by apiTokens.list.",
  input: z.object({}),
  output: z.object({ apps: z.array(appOut) }),
  permission: "api_token:manage_own",
  kind: "read",
  async handler({ tx, actor }) {
    return { apps: await listConnectedApps(tx, actor) };
  },
});

export const connectedAppsUpdate = defineAction({
  name: "connectedApps.update",
  description:
    "Change a connected app's access (read or write) and whether it may publish without approval. Only the person who connected it, in the web app. Not available to callers authenticated by an API token or a connected app. Takes effect on the app's next call.",
  input: z.object({ id: z.uuid(), access: z.enum(["read", "write"]), fullAutonomy: z.boolean() }),
  output: z.object({ app: appOut }),
  permission: "api_token:manage_own",
  kind: "write",
  async preview({ actor }, input) {
    assertNotApiTokenCaller(actor);
    return {
      summary: `Would set a connected app to ${input.access === "write" ? "read and write" : "read only"}${input.fullAutonomy ? ", publishing without approval" : ""}.`,
      diff: { before: null, after: input },
    };
  },
  async handler({ tx, actor, audit }, input) {
    return updateConnectedApp(tx, actor, input, audit);
  },
});

export const connectedAppsDisconnect = defineAction({
  name: "connectedApps.disconnect",
  description:
    "Disconnect an app connected over OAuth. Its next call fails with 401, its refresh token stops working, and connecting it again asks for approval again. Members may disconnect their own apps; owners and admins any app in the organization.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ disconnected: z.boolean() }),
  permission: "api_token:manage_own",
  kind: "write",
  // Direct, like apiTokens.revoke: cutting access must not wait for a second call.
  approval: "own_flow",
  async preview() {
    return { summary: "Would disconnect this app. Its next call fails with 401.", diff: { before: { connected: true }, after: { connected: false } } };
  },
  async handler({ tx, actor, audit }, input) {
    return disconnectConnectedApp(tx, actor, input.id, audit);
  },
});
