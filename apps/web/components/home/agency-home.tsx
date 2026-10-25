import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  SEE_ALL, TYPE_PILLS, ageText, autoApproveText, homeHref, inType, itemChip, itemLink, itemTitle, itemWhere, pillCount, setupOpen, setupSteps, tiles,
  type ChipTone, type Counts, type Queue, type TypeFilter,
} from "../../lib/home";
import { Sparkline } from "../locations/sparkline";
import { buttonClass, secondaryButtonClass } from "../ui";
import { SetupStrip } from "./setup";

const CHIP: Record<ChipTone, string> = {
  agent: "border-agent-border bg-agent-bg text-agent",
  warn: "border-warn-border bg-warn-bg text-warn",
  bad: "border-bad-border bg-bad-bg text-bad",
  neutral: "border-border bg-secondary text-secondary-foreground",
};
const TILE = { brand: "border-border bg-brand-tint", bad: "border-bad-border bg-bad-bg", plain: "border-border bg-card" };
const NUM = { brand: "text-brand-text", bad: "text-bad", plain: "text-foreground" };
export function Tiles({ counts, ws, writesOff }: { counts: Counts; ws: string | null; writesOff: boolean }) {
  const t = useTranslations("home");
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {tiles(counts, { writesOff }, t).map((tile) => (
        <li key={tile.label}>
          <Link
            href={homeHref({ ws, type: tile.type })}
            className={`flex h-full flex-col gap-0.5 rounded-panel border p-3.5 hover:shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${TILE[tile.tone]}`}
          >
            <span className={`font-display text-2xl font-extrabold ${NUM[tile.tone]}`}>{tile.n}</span>
            <span className="text-sm font-semibold text-foreground">{tile.label}</span>
            <span className="text-xs text-muted-foreground">{tile.hint}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function AgencyHome({
  q, ws, type, now, writesOff,
}: { q: Queue; ws: string | null; type: TypeFilter; now: number; writesOff: boolean }) {
  const t = useTranslations("home");
  const shown = inType(q.items, type);
  const total = pillCount(q.counts, type);
  const seeAll = SEE_ALL[type];
  const steps = setupSteps(q.setup, t);
  const chip = autoApproveText(q.autoApprove.map((a) => a.minStars as 4 | 5), t);
  return (
    <div className="flex flex-col gap-5">
      {setupOpen(q.setup, steps) ? <SetupStrip steps={steps} /> : null}
      <Tiles counts={q.counts} ws={ws} writesOff={writesOff} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section aria-label={t("queue.label")} className="flex min-w-0 flex-col gap-3">
          <nav aria-label={t("queue.types")} className="flex flex-wrap gap-2">
            {TYPE_PILLS.map((p) => (
              <Link
                key={p.key}
                href={homeHref({ ws, type: p.key })}
                aria-current={p.key === type ? "page" : undefined}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold ${
                  p.key === type ? "border-foreground bg-foreground text-background" : "border-input text-foreground hover:bg-muted"
                }`}
              >
                {t(`pill.${p.key}`)} <span className="tabular-nums">{pillCount(q.counts, p.key)}</span>
              </Link>
            ))}
          </nav>
          {shown.length === 0 ? (
            <p className="rounded-panel border border-dashed border-input bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              {t("queue.empty")}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-panel border border-border bg-card">
              {shown.map((i) => {
                const link = itemLink(i, ws, t);
                const c = itemChip(i, now, t);
                return (
                  <li key={`${i.subject}:${i.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <strong className="text-sm text-foreground">{itemTitle(i)}</strong>
                        <span className={`text-xs font-semibold ${i.kind === "failed" || i.kind === "negative_review" ? "text-bad" : "text-muted-foreground"}`}>
                          {t(`kind.${i.kind}`)}
                        </span>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {itemWhere(i, t)}
                        {i.subject === "review" && i.detail ? ` · “${i.detail}”` : ""}
                      </span>
                    </div>
                    <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${CHIP[c.tone]}`}>{c.text}</span>
                    <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{ageText(i.at, now, t)}</span>
                    <Link href={link.href} className={link.primary ? buttonClass : secondaryButtonClass}>{link.label}</Link>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
            <span>{t("queue.showing", { shown: shown.length, total })}</span>
            {shown.length < total && seeAll ? (
              <Link href={seeAll.href} className="font-semibold text-brand-text underline underline-offset-2">{t(`seeAll.${type}`)}</Link>
            ) : null}
          </p>
        </section>
        <aside className="flex flex-col gap-4">
          {chip ? (
            <section className="flex flex-col gap-2 rounded-panel border border-warn-border bg-warn-bg p-4 text-sm text-warn">
              <strong>{chip}</strong>
              <span>{q.autoApprove.map((a) => t("autoApprove.line", { name: a.workspaceName, stars: a.minStars })).join(" · ")}</span>
              <Link href="/settings/workspace" className="font-semibold underline">{t("autoApprove.settings")}</Link>
            </section>
          ) : null}
          <section aria-labelledby="clients-h" className="flex flex-col gap-2 rounded-panel border border-border bg-card p-4">
            <div className="flex items-baseline justify-between">
              <h2 id="clients-h" className="font-display text-base font-bold text-foreground">{t("agency.clients")}</h2>
              <Link href={homeHref({ ws: "all" })} className="text-sm font-semibold text-brand-text underline underline-offset-2">{t("agency.allClients")}</Link>
            </div>
            <ul className="flex flex-col divide-y divide-border">
              {q.clients.map((c) => {
                const pts = c.ratingTrend.filter((v): v is number => v !== null);
                return (
                  <li key={c.workspaceId} className="flex items-center gap-3 py-2.5">
                    <span aria-hidden className="flex size-8 items-center justify-center rounded-control bg-secondary font-bold">{c.name[0]}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Link href={homeHref({ ws: c.workspaceId })} className="truncate text-sm font-semibold text-foreground underline-offset-2 hover:underline">{c.name}</Link>
                      <span className="text-xs text-muted-foreground">
                        {t("agency.locations", { n: c.activeLocations })}
                        {c.averageRating !== null ? ` · ${c.averageRating.toFixed(1)}★` : ""}
                      </span>
                    </span>
                    <span className="w-14"><Sparkline values={pts} up={pts.length < 2 || pts[pts.length - 1]! >= pts[0]!} /></span>
                    <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-bold ${c.attention > 5 ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
                      {c.attention}<span className="sr-only"> {t("agency.needAttention")}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
