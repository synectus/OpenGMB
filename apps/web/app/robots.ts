import type { MetadataRoute } from "next";

// Community edition: search engines may read public location pages and nothing else (proxy.ts sends noindex too).
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/l/", disallow: "/" }] };
}
