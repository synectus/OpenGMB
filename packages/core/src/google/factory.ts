import type { Db } from "@opengmb/db";
import { recordConnectionError, recordConnectionOk } from "../admin-capture";
import { CoreError } from "../errors";
import type { GoogleClient } from "./client";
import { createAccessTokenProvider } from "./access-token";
import { LiveGoogleClient } from "./live-client";
import { MockGoogleClient } from "./mock-client";
import { ReadOnlyGoogleClient } from "./read-only-client";
import type { Clock } from "./throttler";
import { ThrottledGoogleClient } from "./throttled-client";

let sharedMock: MockGoogleClient | null = null;
/**
 * Test hook: in mock mode, `createGoogleClient` hands out THIS mock instead of a fresh one, so an
 * action (which builds its own client) and the test see the same in-memory Google. Pass null to reset.
 */
export function setSharedMockGoogleClient(mock: MockGoogleClient | null) {
  sharedMock = mock;
}

/**
 * `GOOGLE_BUSINESS_API_MODE`: unset or `mock` gives the fixture-backed client, `live` the real one.
 * Live stays unused until Google approves Basic Access for the Business Profile APIs.
 * In live mode writes are refused (`ReadOnlyGoogleClient`) unless `GOOGLE_BUSINESS_WRITES=live`.
 */
export function createGoogleClient(p: {
  db: Db;
  connection: { refreshTokenEnc: string; orgId?: string; id?: string };
  clock?: Partial<Clock>;
}): ThrottledGoogleClient {
  const mode = process.env.GOOGLE_BUSINESS_API_MODE?.trim() || "mock";
  let inner: GoogleClient;
  if (mode === "mock") inner = sharedMock ?? new MockGoogleClient();
  else if (mode === "live") {
    // AP1b: connection health. `p.db` is the root db every caller passes; capture swallows its own errors.
    const { id, orgId } = p.connection;
    const health = id && orgId ? { connectionId: id, orgId } : null;
    const live = new LiveGoogleClient({
      getAccessToken: createAccessTokenProvider(p.connection, {
        onRefreshOk: health ? () => recordConnectionOk(p.db, health) : undefined,
        onRefreshError: health ? (code) => recordConnectionError(p.db, health, code) : undefined,
      }),
    });
    const writes = process.env.GOOGLE_BUSINESS_WRITES?.trim() || "off";
    if (writes === "live") inner = live;
    else if (writes === "off") inner = new ReadOnlyGoogleClient(live);
    else throw new CoreError("NOT_CONFIGURED", `Unknown GOOGLE_BUSINESS_WRITES "${writes}"`);
  } else {
    throw new CoreError("NOT_CONFIGURED", `Unknown GOOGLE_BUSINESS_API_MODE "${mode}"`);
  }
  return new ThrottledGoogleClient(inner, p.db, p.clock, p.connection.orgId);
}
