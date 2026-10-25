import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { googleConnections, users } from "@opengmb/db";
import { AccessError } from "../actor";
import {
  googleConnectionAuditView,
  isGoogleConnectConfigured,
  revokeStoredRefreshToken,
  startGoogleConnection,
} from "../google/oauth";
import { GOOGLE_OAUTH_BRAND } from "../config/google-oauth-brand";
import { insertMockGoogleConnection, isMockGoogleMode, MOCK_AUDIT_AFTER } from "../google/dev-seed";
import { CoreError } from "../errors";
import { defineAction } from "../registry";

const REMOVE_ACCESS_URL = "https://myaccount.google.com/permissions";

const connectionOut = z.object({
  id: z.string(),
  email: z.string(),
  googleAccountId: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  connectedBy: z.string(),
});

export const googleConnectionsList = defineAction({
  name: "googleConnections.list",
  description:
    "List the Google accounts connected to the caller's organization for Business Profile access, newest first. Never returns token material. configured is false when the server has no Google OAuth credentials, in which case connecting is unavailable. sampleAvailable is true only in mock mode (GOOGLE_BUSINESS_API_MODE=mock), where googleConnections.connectSample can add the sample Google account.",
  input: z.object({}),
  output: z.object({ configured: z.boolean(), sampleAvailable: z.boolean(), connections: z.array(connectionOut) }),
  permission: "google:read",
  kind: "read",
  async handler({ tx, actor }) {
    const rows = await tx
      .select({ c: googleConnections, connectedBy: users.email })
      .from(googleConnections)
      .innerJoin(users, eq(users.id, googleConnections.userId))
      .where(eq(googleConnections.orgId, actor.orgId))
      .orderBy(desc(googleConnections.createdAt));
    return {
      configured: isGoogleConnectConfigured(),
      sampleAvailable: isMockGoogleMode(),
      connections: rows.map(({ c, connectedBy }) => ({
        id: c.id,
        email: c.googleAccountEmail,
        googleAccountId: c.googleAccountId,
        scopes: c.scopes,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        connectedBy,
      })),
    };
  },
});

export const googleConnectionsConnect = defineAction({
  name: "googleConnections.connect",
  description:
    "Start connecting a Google account. Returns an authUrl that must be opened in a browser where the SAME user is signed in to OpenGMB; it expires at expiresAt (10 minutes) and works once. The connection is created when Google redirects back to OpenGMB.",
  input: z.object({}),
  output: z.object({ authUrl: z.string(), expiresAt: z.string() }),
  permission: "google:manage",
  kind: "write",
  async handler({ tx, actor, audit }) {
    const { stateId, expiresAt, authUrl } = await startGoogleConnection(tx, {
      orgId: actor.orgId,
      userId: actor.userId,
    });
    await audit({
      action: "google_connection.connect_started",
      entityType: "google_oauth_state",
      entityId: stateId,
      before: null,
      after: { expiresAt: expiresAt.toISOString() },
    });
    return { authUrl, expiresAt: expiresAt.toISOString() };
  },
});

export const googleConnectionsConnectSample = defineAction({
  name: "googleConnections.connectSample",
  description:
    "Mock mode only (GOOGLE_BUSINESS_API_MODE=mock): connect the built-in sample Google account to the caller's organization, so the sample locations can be imported without Google credentials. Refused with NOT_CONFIGURED in live mode. Idempotent: created is false when the sample account is already connected.",
  input: z.object({}),
  output: z.object({ connectionId: z.string(), created: z.boolean() }),
  permission: "google:manage",
  kind: "write",
  async handler({ tx, actor, audit }) {
    if (!isMockGoogleMode()) {
      throw new CoreError("NOT_CONFIGURED", "The sample Google account is only available in mock mode");
    }
    const r = await insertMockGoogleConnection(tx, actor.orgId, actor.userId);
    // Every write action must leave an audit row, so a repeat click records created: false.
    await audit({
      action: "google_connection.sample_connect",
      entityType: "google_connection",
      entityId: r.connectionId,
      before: null,
      after: { ...MOCK_AUDIT_AFTER, created: r.created },
    });
    return r;
  },
});

export const googleConnectionsDisconnect = defineAction({
  name: "googleConnections.disconnect",
  description: `Disconnect a Google account: revoke its refresh token at Google (best effort), then delete the connection. If Google could not be reached, the connection is still removed locally, revokedAtGoogle is false and warning says to remove access at ${REMOVE_ACCESS_URL}.`,
  input: z.object({ id: z.uuid() }),
  output: z.object({ revokedAtGoogle: z.boolean(), warning: z.string().nullable() }),
  permission: "google:manage",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    const [row] = await tx
      .select()
      .from(googleConnections)
      .where(and(eq(googleConnections.id, input.id), eq(googleConnections.orgId, actor.orgId)));
    // Another org's connection looks exactly like a missing one.
    if (!row) throw new AccessError("NOT_FOUND", "Google connection not found");
    const revokedAtGoogle = await revokeStoredRefreshToken(row.refreshTokenEnc);
    const deleted = await tx
      .delete(googleConnections)
      .where(and(eq(googleConnections.id, row.id), eq(googleConnections.orgId, actor.orgId)))
      .returning({ id: googleConnections.id });
    if (deleted.length === 0) throw new CoreError("CONFLICT", "Google connection already removed");
    await audit({
      action: "google_connection.delete",
      entityType: "google_connection",
      entityId: row.id,
      before: googleConnectionAuditView(row),
      after: { revokedAtGoogle },
    });
    return {
      revokedAtGoogle,
      warning: revokedAtGoogle
        ? null
        : `Disconnected here, but Google could not be told to revoke access. Remove ${GOOGLE_OAUTH_BRAND.appName.value} at ${REMOVE_ACCESS_URL}.`,
    };
  },
});
