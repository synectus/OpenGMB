import type { MetadataRoute } from "next";

/** Served at /manifest.webmanifest. Colours are the light-theme primary and background tokens. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "OpenGMB",
    short_name: "OpenGMB",
    description: "Manage Google Business Profiles: reviews, posts and approvals.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#c2410c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
