"use client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { buttonClass, secondaryButtonClass } from "../ui";

// Two-factor is optional (2026-10-30). The card is shown to people without it until they dismiss it. "Dismissed" is a
// per-person convenience, so like the product tour it lives in this browser only.
const KEY = "opengmb.2fa-nudge.dismissed";

const listeners = new Set<() => void>();
const read = () => {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
function dismiss() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Private window: the card simply comes back next visit.
  }
  listeners.forEach((fn) => fn());
}

export function TwoFactorNudge() {
  const t = useTranslations("home.twoFactorNudge");
  // Server and first client render both say "dismissed", so nothing flashes or mismatches; the real value arrives after hydration.
  const dismissed = useSyncExternalStore(subscribe, read, () => true);
  if (dismissed) return null;
  return (
    <section aria-labelledby="two-factor-nudge-h" className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 id="two-factor-nudge-h" className="font-display text-base font-bold text-foreground">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">{t("text")}</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/mfa/setup" className={buttonClass}>{t("cta")}</Link>
        <button type="button" className={secondaryButtonClass} onClick={dismiss}>{t("dismiss")}</button>
      </div>
    </section>
  );
}
