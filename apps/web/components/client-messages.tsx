import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import type { ReactNode } from "react";
import { MESSAGE_SETS, pickMessages, type MessageSet } from "../messages/client";

/**
 * Sends the browser the namespaces of one set (messages/client.ts) for the subtree below it. The
 * inner provider REPLACES the outer messages, so the set is the full list for the subtree. Put it
 * in the layout of the route (or the page when the route has no folder of its own).
 */
export async function ClientMessages({ set, children }: { set: MessageSet; children: ReactNode }) {
  return (
    <NextIntlClientProvider messages={pickMessages(await getMessages(), MESSAGE_SETS[set])}>
      {children}
    </NextIntlClientProvider>
  );
}
