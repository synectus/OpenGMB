import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { SECURITY_HEADERS } from "./lib/security-headers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// forceReload: Next has already loaded apps/web/.env* and caches that result, so a plain call is a no-op.
loadEnvConfig(repoRoot, process.env.NODE_ENV === "development", console, true);

const nextConfig: NextConfig = {
  transpilePackages: ["@opengmb/core", "@opengmb/db"],
  // Dev server only: lets e2e/custom-domain.spec.ts load /_next assets through a mapped agency hostname. No effect in production.
  allowedDevOrigins: ["portal.e2e.test"],
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // The widget script is loaded by other people's sites, including ones that isolate their pages
      // (Cross-Origin-Embedder-Policy), which refuse a cross-origin file unless it opts in like this.
      { source: "/widget.js", headers: [{ key: "Cross-Origin-Resource-Policy", value: "cross-origin" }] },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

export default withNextIntl(nextConfig);
