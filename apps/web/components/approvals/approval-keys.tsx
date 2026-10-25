"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { actionForKey, isTypingTarget } from "../../lib/approvals";

export function ApprovalKeys({
  prevHref,
  nextHref,
}: {
  prevHref: string | null;
  nextHref: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (document.querySelector('[role="dialog"]')) return;
      // The notifications popover and the mobile drawer are not dialogs: stand down unless focus is
      // on the page itself (body) or inside an interactive <main>.
      const main = document.querySelector("main");
      if (main?.closest("[inert]")) return;
      const active = document.activeElement;
      if (active && active !== document.body && !main?.contains(active)) return;
      const action = actionForKey(e, isTypingTarget(document.activeElement));
      if (!action) return;
      if (action === "next" && nextHref) router.push(nextHref);
      else if (action === "prev" && prevHref) router.push(prevHref);
      else if (action === "approve") {
        document
          .querySelector<HTMLButtonElement>("[data-approval-action='approve']:not(:disabled)")
          ?.click();
      } else if (action === "sendBack") {
        const reason = document.querySelector<HTMLInputElement>("[data-approval-reason]");
        if (reason) {
          e.preventDefault(); // otherwise the "s" is typed into the field we just focused
          reason.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router, prevHref, nextHref]);
  return null;
}
