/* eslint-disable @next/next/no-location-assign-relative-destination -- full page load on purpose so server components see the new session cookie */
import { createAuthClient } from "better-auth/react";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [
    magicLinkClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.href = "/mfa/verify";
      },
    }),
  ],
});
