import { createAuthClient } from "better-auth/react";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

/** True while the page URL carries a signed OAuth authorize request (an MCP client is connecting). */
export const inOAuthFlow = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("sig");

export const authClient = createAuthClient({
  plugins: [
    magicLinkClient(),
    // Adds oauth_query (the signed authorize request in the page URL) to sign-in and 2FA calls.
    oauthProviderClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        // Keep the signed OAuth request so the code step can resume the authorize flow.
        window.location.href = inOAuthFlow() ? `/mfa/verify${window.location.search}` : "/mfa/verify";
      },
    }),
  ],
});
