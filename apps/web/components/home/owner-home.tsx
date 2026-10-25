import Link from "next/link";
import { useTranslations } from "next-intl";
import { daysAgoLabel, deltaLabel, nextActions, setupOpen, setupSteps, type Queue } from "../../lib/home";
import { Badge, buttonClass, secondaryButtonClass } from "../ui";
import { SetupChecklist } from "./setup";

const TONE = { bad: "border-bad-border bg-bad-bg", brand: "border-border bg-card", warn: "border-warn-border bg-warn-bg" };

function Kpi({ label, k }: { label: string; k: { total: number; deltaPct: number | null } }) {
  const t = useTranslations("home");
  const d = deltaLabel(k.deltaPct, t);
  return (
    <span className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="text-foreground">{k.total}</strong>
      {d ? <span className={`text-xs ${d.dir === "down" ? "text-bad" : d.dir === "up" ? "text-good" : "text-muted-foreground"}`}>{d.text}</span> : null}
    </span>
  );
}

export function OwnerHome({ q, now, canDismiss }: { q: Queue; now: number; canDismiss: boolean }) {
  const t = useTranslations("home");
  const steps = setupSteps(q.setup, t);
  const actions = nextActions(q.counts, q.locations, now, t);
  return (
    <div className="flex flex-col gap-6">
      {setupOpen(q.setup, steps) ? <SetupChecklist steps={steps} canDismiss={canDismiss} /> : null}
      {actions.length > 0 ? (
        <section aria-labelledby="next-h" className="flex flex-col gap-3">
          <h2 id="next-h" className="font-display text-lg font-bold text-foreground">{t("owner.doNext")}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {actions.map((a, i) => (
              <article key={a.title} className={`flex flex-col gap-2 rounded-panel border p-4 ${TONE[a.tone]}`}>
                <strong className="text-foreground">{a.title}</strong>
                <span className="flex-1 text-sm text-muted-foreground">{a.text}</span>
                {a.cta ? <Link href={a.href} className={i === 0 ? buttonClass : secondaryButtonClass}>{a.cta}</Link> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <section aria-labelledby="loc-h" className="flex flex-col gap-3">
        <h2 id="loc-h" className="font-display text-lg font-bold text-foreground">{t("owner.yourLocations")}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {q.locations.map((l) => (
            <article key={l.id} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-display font-bold text-foreground">{l.title}</h3>
                  <p className="truncate text-sm text-muted-foreground">{l.addressSummary ?? t("owner.noAddress")}</p>
                </div>
                {l.suspensionOpen ? <Badge tone="danger">{t("owner.suspension")}</Badge> : null}
              </div>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                {l.reviews.avgRating !== null ? (
                  <span role="img" aria-label={t("owner.stars", { rating: l.reviews.avgRating.toFixed(1) })} className="font-semibold text-foreground">
                    {l.reviews.avgRating.toFixed(1)} <span className="text-brand">★</span>
                  </span>
                ) : null}
                <span className="text-muted-foreground">{t("owner.reviews", { n: l.reviews.total })}</span>
                {l.reviews.unreplied > 0 ? (
                  <Link href={`/reviews?loc=${l.id}&replied=no`} className="font-semibold text-brand-text underline underline-offset-2">
                    {t("owner.withoutReply", { n: l.reviews.unreplied })}
                  </Link>
                ) : null}
                {l.reviews.waitingToPublish > 0 ? (
                  <span className="text-muted-foreground">{t("owner.waitingToPublish", { n: l.reviews.waitingToPublish })}</span>
                ) : null}
                {l.openChanges > 0 ? (
                  <Link href="/locations/alerts" className="font-semibold text-warn underline underline-offset-2">
                    {t("owner.changesFound", { n: l.openChanges })}
                  </Link>
                ) : null}
              </div>
              {l.performance.hasData ? (
                <div className="flex gap-6 rounded-control bg-muted px-3 py-2">
                  <Kpi label={t("owner.callsLabel")} k={l.performance.calls} />
                  <Kpi label={t("owner.directionsLabel")} k={l.performance.directions} />
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <span>{t("owner.noPerformance")}</span>
                  <Link href="/performance" className="font-semibold text-brand-text underline underline-offset-2">{t("owner.fetch")}</Link>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                {l.lastPostAt ? t("owner.lastPost", { when: daysAgoLabel(l.lastPostAt, new Date(now), t) }) : t("owner.noPostsYet")}
              </p>
              <nav aria-label={t("owner.pages", { title: l.title })} className="flex gap-4 text-sm font-medium">
                <Link href={`/reviews?loc=${l.id}`} className="text-muted-foreground underline underline-offset-2">{t("owner.reviewsLink")}</Link>
                <Link href="/posts" className="text-muted-foreground underline underline-offset-2">{t("owner.postsLink")}</Link>
                <Link href={`/locations/${l.id}/profile`} className="text-muted-foreground underline underline-offset-2">{t("owner.profileLink")}</Link>
                <Link href="/performance" className="text-muted-foreground underline underline-offset-2">{t("owner.performanceLink")}</Link>
              </nav>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
