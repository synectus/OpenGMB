import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import { ClientMessages } from "../components/client-messages";
import { Inter, Noto_Sans_Devanagari, Plus_Jakarta_Sans } from "next/font/google";
import { THEME_COOKIE, parseTheme } from "../lib/preferences";
import { themeCss } from "../lib/theme/tokens";
import "./globals.css";
import { NonceStyle } from "../components/nonce-style";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

// Inter and Jakarta have no Devanagari glyphs. Only Hindi pages get this font's class, so English and
// Spanish never download it; next/font self-hosts it, so the CSP's font-src needs no change.
const devanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-devanagari",
  display: "swap",
  preload: false,
});

export const metadata = {
  title: "OpenGMB",
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/favicon.ico", sizes: "48x48" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: "OpenGMB" },
};
export const viewport = { themeColor: "#c2410c" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang={locale}
      data-theme={theme === "system" ? undefined : theme}
      className={`${inter.variable} ${jakarta.variable}${locale === "hi" ? ` ${devanagari.variable}` : ""}`}
    >
      <head>
        {/* Token values; trusted constant from lib/theme/tokens.ts. */}
        <NonceStyle css={themeCss()} />
      </head>
      <body>
        <ClientMessages set="root">{children}</ClientMessages>
      </body>
    </html>
  );
}
