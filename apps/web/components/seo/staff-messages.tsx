import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import type { ReactNode } from "react";
import { MESSAGE_SETS, pickMessages } from "../../messages/client";

/**
 * Gives the client components below it the `seoKeywordsCost` namespace (the price line and charged
 * amounts). That namespace is in no message set (messages/client.ts); render this only for roles with
 * geogrid:cost. An inner provider REPLACES the outer messages, so the seoKeywords set is passed along.
 */
export async function SeoStaffMessages({ children }: { children: ReactNode }) {
  const all = await getMessages();
  return (
    <NextIntlClientProvider messages={{ ...pickMessages(all, MESSAGE_SETS.seoKeywords), seoKeywordsCost: all.seoKeywordsCost }}>
      {children}
    </NextIntlClientProvider>
  );
}
