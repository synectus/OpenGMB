import Link from "next/link";
import { EMPTY_STATES, type EmptyId } from "../lib/empty-states";
import { EmptyState } from "./ui";
import { primaryLinkButtonClass } from "./page-parts";

/**
 * The "nothing here yet" state of a page, from lib/empty-states.ts: what to do next in plain words
 * and one link. `href` swaps in a more specific target (the chosen client or location);
 * `noLink` leaves the link off for someone who cannot act (the text then says whom to ask).
 */
export function EmptyNext({ id, href, noLink, ask }: { id: EmptyId; href?: string; noLink?: boolean; ask?: string }) {
  const e = EMPTY_STATES[id];
  const to = href ?? e.cta.href;
  return (
    <EmptyState
      title={e.title}
      action={
        noLink ? undefined : to.startsWith("#") ? (
          <a href={to} className={primaryLinkButtonClass}>{e.cta.label}</a>
        ) : (
          <Link href={to} className={primaryLinkButtonClass}>{e.cta.label}</Link>
        )
      }
    >
      {noLink && ask ? ask : e.next}
    </EmptyState>
  );
}
