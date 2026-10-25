import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import type { ReactNode } from "react";
import { MESSAGE_SETS, pickMessages } from "../../messages/client";

/**
 * Gives the client components below it the `geogridCost` namespace (budget, markup, key resale,
 * charged). That namespace is deliberately in no message set (messages/client.ts), so no layout
 * serializes it for a client viewer; render this only for roles with geogrid:cost. An inner
 * provider's `messages` REPLACES the outer set (use-intl reads only its own props), so the
 * geogrid set is passed along with it.
 */
export async function StaffMessages({ children }: { children: ReactNode }) {
  const all = await getMessages();
  return (
    <NextIntlClientProvider messages={{ ...pickMessages(all, MESSAGE_SETS.geogrid), geogridCost: all.geogridCost }}>
      {children}
    </NextIntlClientProvider>
  );
}
