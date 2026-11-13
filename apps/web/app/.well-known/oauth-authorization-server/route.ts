import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "../../../lib/auth";

// RFC 8414 at the root: the issuer is BETTER_AUTH_URL (no path), the endpoints are under /api/auth.
export const dynamic = "force-dynamic";

export const GET = (req: Request) =>
  oauthProviderAuthServerMetadata(getAuth(), {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
  })(req);
