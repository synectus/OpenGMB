import Link from "next/link";
import { useTranslations } from "next-intl";
import { DismissSetup } from "./dismiss-setup";
import { setupLine, type Step } from "../../lib/home";
import { Badge, buttonClass, secondaryButtonClass } from "../ui";

export function SetupProgress({ steps }: { steps: Step[] }) {
  const t = useTranslations("home");
  const done = steps.filter((s) => s.done).length;
  return (
    <div
      role="progressbar"
      aria-label={t("setup.progress")}
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={done}
      className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${(done / steps.length) * 100}%` }} />
    </div>
  );
}

/** Full checklist: owner Home while any step is open. */
export function SetupChecklist({ steps, canDismiss }: { steps: Step[]; canDismiss: boolean }) {
  const t = useTranslations("home");
  const next = steps.find((s) => !s.done);
  return (
    <section aria-labelledby="setup-h" className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h2 id="setup-h" className="font-display text-base font-bold text-foreground">{t("setup.gettingStarted")}</h2>
        {canDismiss ? <DismissSetup /> : null}
      </div>
      <SetupProgress steps={steps} />
      <p className="text-sm text-muted-foreground">{setupLine(steps, t)}</p>
      <ol className="flex flex-col divide-y divide-border">
        {steps.map((s) => (
          <li key={s.title} className={`flex items-center gap-3 py-3 ${s === next ? "rounded-control bg-brand-tint px-2" : ""}`}>
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                s.done ? "bg-good text-card" : s === next ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
              }`}
            >
              {s.done ? "✓" : steps.indexOf(s) + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                {s.title} <span className="sr-only">{s.done ? t("setup.done") : t("setup.notDone")}</span>
              </p>
              <p className="text-sm text-muted-foreground">{s.hint}</p>
            </div>
            {s.done ? (
              <Badge tone="success">{t("setup.badgeDone")}</Badge>
            ) : (
              <Link href={s.href} className={s === next ? buttonClass : secondaryButtonClass}>{s.cta}</Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Slim strip: agency Home while any step is open. */
export function SetupStrip({ steps }: { steps: Step[] }) {
  const t = useTranslations("home");
  const next = steps.find((s) => !s.done);
  if (!next) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-panel border border-border bg-card px-4 py-2.5 text-sm">
      <strong className="text-foreground">{t("setup.strip", { done: steps.filter((s) => s.done).length, total: steps.length })}</strong>
      <div className="w-32"><SetupProgress steps={steps} /></div>
      <span className="text-muted-foreground">{t("setup.next", { title: next.title.toLowerCase() })}</span>
      <Link href={next.href} className="ml-auto font-semibold text-brand-text underline underline-offset-2">{next.cta}</Link>
    </div>
  );
}
