"use client";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import { buttonClass, secondaryButtonClass } from "../ui";

// G6: a short tour for a brand-new account. "Seen" is a per-person convenience, so it lives in this browser only.
const KEY = "opengmb.tour.done";
const STEPS = ["home", "reviews", "approvals", "plan"] as const;

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
function finish() {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Private window: the tour simply comes back next visit.
  }
  listeners.forEach((fn) => fn());
}

export function ProductTour() {
  const t = useTranslations("home.tour");
  // Server and first client render both say "seen", so nothing flashes or mismatches; the real value arrives after hydration.
  const seen = useSyncExternalStore(subscribe, read, () => true);
  const [i, setI] = useState(0);
  if (seen) return null;
  const last = i === STEPS.length - 1;
  const step = STEPS[i]!;
  return (
    <section aria-labelledby="tour-h" className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h2 id="tour-h" className="font-display text-base font-bold text-foreground">{t("title")}</h2>
        <span className="text-xs text-muted-foreground">{t("progress", { n: i + 1, total: STEPS.length })}</span>
      </div>
      <p className="font-semibold text-foreground">{t(`${step}.title`)}</p>
      <p className="text-sm text-muted-foreground">{t(`${step}.text`)}</p>
      <div className="flex flex-wrap gap-3">
        {i > 0 ? (
          <button type="button" className={secondaryButtonClass} onClick={() => setI(i - 1)}>{t("back")}</button>
        ) : null}
        {last ? (
          <button type="button" className={buttonClass} onClick={finish}>{t("done")}</button>
        ) : (
          <button type="button" className={buttonClass} onClick={() => setI(i + 1)}>{t("next")}</button>
        )}
        <button type="button" className={secondaryButtonClass} onClick={finish}>{t("skip")}</button>
      </div>
    </section>
  );
}
