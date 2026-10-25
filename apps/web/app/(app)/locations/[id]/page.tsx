import Link from "next/link";
import { enumLabel, plainText } from "@/lib/labels";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import type { locationsOverview, performanceSummary } from "@opengmb/core";
import {
  HEALTHCHECK_CONFIG,
  PERFORMANCE_CONFIG,
  PROFILE_WATCH_CONFIG,
  emailConfigured,
  roleHasPermission,
  integrationEnv,
} from "@opengmb/core";
import { AiVisibilityPanel } from "../../../../components/ai-visibility/panel";
import { ProvenanceChip } from "../../../../components/approvals/provenance-chip";
import { LocationPagePanel } from "../../../../components/locations/location-page-panel";
import { LocationStatusToggle } from "../../../../components/locations/location-status-toggle";
import { Sparkline } from "../../../../components/locations/sparkline";
import { Pill } from "../../../../components/page-parts";
import { ErrorText, Panel, linkClass } from "../../../../components/ui";
import { actorContextFor } from "../../../../lib/auth";
import { requireUser } from "../../../../lib/guard";
import { liveStatus } from "../../../../lib/live-status";
import { googleWritesLive } from "../../../../lib/settings-nav";
import { waitingToPublishText } from "../../../../lib/waiting-to-publish";
import {
  attentionItems,
  bookingTypeLabel,
  cronTimeUtc,
  daysSince,
  deltaText,
  last28Days,
} from "../../../../lib/location-hub";
import { isUuid } from "../../../../lib/locations";
import { getTimeFormat } from "../../../../lib/time-format-server";
import { locationPages_get, locations_overview, performance_summary } from "../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Overview = Handler<typeof locationsOverview>;
type Summary = Handler<typeof performanceSummary>;

function Tile({
  label,
  value,
  sub,
  link,
  muted,
}: {
  label: string;
  value: ReactNode;
  sub?: string | null;
  link?: { href: string; label: string } | null;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-control border border-border bg-card p-4">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className={`tabular-nums ${muted ? "text-sm text-muted-foreground" : "font-display text-xl font-extrabold text-foreground"}`}>
        {value}
      </div>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      {link && (
        <Link href={link.href} className={`${linkClass} text-xs`}>
          {link.label}
        </Link>
      )}
    </div>
  );
}

function Stars({ avg }: { avg: number }) {
  const full = Math.round(avg);
  return (
    <span aria-hidden className="ml-2 text-base tracking-wide text-brand">
      {"★".repeat(full)}
      <span className="text-border">{"★".repeat(5 - full)}</span>
    </span>
  );
}

/** The Attention link name: change sets link to Approvals. */
const linkKey = (key: string) => (key.startsWith("cs-") ? "approvals" : key);

const KPIS = [{ key: "calls" }, { key: "websiteClicks" }, { key: "directions" }] as const;

export default async function LocationOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("locationHub.hub");
  const tv = await getTranslations("locationHub.verif");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { role } = await actorContextFor(userId);
  const can = (p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(role, p);
  const canManage = can("location:manage");
  const canEdit = can("profile:edit");
  const canDraft = can("review:draft");

  const now = new Date();
  const tf = await getTimeFormat();
  const ov = await locations_overview({ locationId: id });
  if (!ov.ok) {
    if (ov.error.code === "NOT_FOUND") notFound();
    return <ErrorText message={`${ov.error.code}: ${ov.error.message}`} />;
  }
  const o = ov.data as Overview;
  const pg = await locationPages_get({ locationId: id });
  const pageInfo = pg.ok ? (pg.data as { page: { path: string; published: boolean } | null }).page : null;
  const ws = o.location.workspaceId;
  const range = last28Days(now, tf.zone(ws));
  const perf = await performance_summary({ locationIds: [id], from: range.from, to: range.to });
  const g = o.google;
  const status = liveStatus(integrationEnv(), emailConfigured());
  const simulated = status.rows.find((r) => r.key === "google")?.state === "simulated";
  const writesOff = status.rows.find((r) => r.key === "writes")?.state === "off";
  const snapshotUtc = cronTimeUtc(PROFILE_WATCH_CONFIG.snapshotCron);
  const base = `/locations/${id}`;
  const unlinked = o.location.needsRelink;
  const lastSynced = o.syncs.lastReviewSyncAt ? t("lastSynced", { date: tf.date(o.syncs.lastReviewSyncAt, ws) }) : null;
  const ago = (iso: string) => {
    const d = daysSince(iso, now);
    return d <= 0 ? t("today") : d === 1 ? t("dayAgo") : t("daysAgo", { days: d });
  };
  const setLine = (c: { fieldNames: string[]; locationCount: number }) =>
    t("changeSetLine", { fields: c.fieldNames.join(", "), count: c.locationCount });
  const hoursLine = (hoursToday: string | null, openNow: boolean | null) =>
    !hoursToday
      ? t("hoursClosedToday")
      : t(openNow === null ? "hoursOpenToday" : openNow ? "hoursOpenNow" : "hoursClosedNow", { hours: hoursToday });
  // The same definition Home and Posts use (SynGMB-made or made on Google), not the live read, so the pages agree.
  const lastPostAt = o.lastPost?.publishedAt ?? null;
  const attention = attentionItems(
    {
      locationId: id,
      stats: o.stats,
      changeSets: o.changeSets,
      photos: g?.photos ? { newestDays: g.photos.newestDays } : null,
    },
    { snapshotUtc, recentPhotoDays: HEALTHCHECK_CONFIG.recentPhotoDays },
  );
  const approved = o.changeSets.filter((c) => c.status === "approved");
  const s = perf.ok ? (perf.data as Summary) : null;

  return (
    <div className="flex flex-col gap-5">
      {unlinked && (
        <p role="status" className="rounded-control border border-bad-border bg-bad-bg px-3 py-2 text-sm text-bad">
          {t.rich("notLinked", {
            link: (chunks) => (
              <Link href={`/locations/import?ws=${o.location.workspaceId}`} className="font-semibold underline underline-offset-2">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      {o.location.status === "inactive" && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-input bg-secondary px-3 py-2 text-sm text-foreground">
          <span>{t("inactive")}</span>
          {canManage && <LocationStatusToggle id={id} name={o.location.name} status="inactive" />}
        </div>
      )}
      {o.suspension && (
        <div role="status" className="flex flex-col gap-1 rounded-control border border-bad-border bg-bad-bg px-3 py-2 text-sm text-bad">
          <span className="font-semibold">{t("suspendedSince", { date: tf.date(o.suspension.openedAt, ws) })}</span>
          <span>
            {t("suspensionEvidence", { done: o.suspension.evidenceDone, total: o.suspension.evidenceTotal })}{" "}
            <Link href={`${base}/suspension`} className="font-semibold underline underline-offset-2">
              {t("openSuspension")}
            </Link>
          </span>
        </div>
      )}
      {(o.syncs.reviewsPending || o.syncs.performanceBackfillPending) && (
        <div className="flex flex-col gap-1">
          {o.syncs.reviewsPending && (
            <p role="status" className="rounded-control bg-info-bg px-3 py-2 text-sm text-info">
              {t("reviewSyncQueued")}
            </p>
          )}
          {o.syncs.performanceBackfillPending && (
            <p role="status" className="rounded-control bg-info-bg px-3 py-2 text-sm text-info">
              {t("backfillQueued", { months: PERFORMANCE_CONFIG.retentionMonths.value })}
            </p>
          )}
        </div>
      )}

      <section aria-label={t("keyFigures")} className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {unlinked ? (
          <>
            <Tile label={t("tile.rating")} value="–" sub={lastSynced} muted />
            <Tile label={t("tile.unreplied")} value="–" sub={lastSynced} muted />
            <Tile label={t("tile.lastPost")} value="–" sub={lastSynced} muted />
          </>
        ) : (
          <>
            {o.stats.reviews.total === 0 ? (
              <Tile label={t("tile.rating")} value={t("noReviews")} muted />
            ) : (
              <Tile
                label={t("tile.rating")}
                value={
                  <>
                    {o.stats.reviews.avgRating?.toFixed(1) ?? "–"}
                    {o.stats.reviews.avgRating !== null && <Stars avg={o.stats.reviews.avgRating} />}
                  </>
                }
                sub={t("reviewCount", { count: o.stats.reviews.total })}
              />
            )}
            <Tile
              label={t("tile.unreplied")}
              value={o.stats.reviews.unreplied}
              sub={o.stats.reviews.waitingToPublish > 0 ? waitingToPublishText(o.stats.reviews.waitingToPublish, !googleWritesLive(process.env)) : null}
              link={canDraft && o.stats.reviews.unreplied > 0 ? { href: `/reviews?replied=no&loc=${id}`, label: t("reply") } : null}
            />
            {lastPostAt ? (
              <Tile
                label={t("tile.lastPost")}
                value={tf.date(lastPostAt, ws)}
                sub={o.lastPost?.source === "google" ? t("madeOnGoogle", { ago: ago(lastPostAt) }) : ago(lastPostAt)}
                link={canDraft ? { href: "/posts?view=compose", label: t("writePost") } : null}
              />
            ) : (
              <Tile label={t("tile.lastPost")} value={t("noPosts")} muted link={canDraft ? { href: "/posts?view=compose", label: t("writePost") } : null} />
            )}
          </>
        )}
        {o.stats.openChanges === 0 ? (
          <Tile label={t("tile.openChanges")} value={t("noChangesYet")} muted />
        ) : (
          <Tile label={t("tile.openChanges")} value={o.stats.openChanges} link={{ href: `${base}/changes`, label: t("reviewChanges") }} />
        )}
        {g ? (
          <Tile
            label={t("tile.health")}
            value={`${g.health.percent}%`}
            sub={t("checksPass", { passed: g.health.passed, total: g.health.total })}
            link={{ href: `${base}/health`, label: t("openHealth") }}
          />
        ) : (
          <Tile label={t("tile.health")} value={t("notChecked")} muted link={{ href: `${base}/health`, label: t("openHealth") }} />
        )}
        <Tile
          label={t("tile.verification")}
          value={
            g?.verification ? (
              <Pill tone={g.verification.standing === "good_standing" ? "good" : "warn"}>{tv.has(`standing.${g.verification.standing}`) ? tv(`standing.${g.verification.standing}`) : t("unknown")}</Pill>
            ) : (
              t("unknown")
            )
          }
          sub={g?.verification ? t(g.verification.hasVoiceOfMerchant ? "voiceYes" : "voiceNo") : null}
          muted={!g?.verification}
        />
      </section>

      {!canManage && !canEdit && (
        <p className="text-sm text-muted-foreground">{t("viewOnly")}</p>
      )}
      {o.stats.openChanges === 0 && !unlinked && (
        <p className="text-xs text-muted-foreground">
          {t("baselineNote", { time: snapshotUtc })}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <Panel title={t("needsAttention")}>
            {attention.length === 0 && approved.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("nothingNeeds")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {attention.map((a) => (
                  <li key={a.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="flex flex-wrap items-center gap-2 text-foreground">
                      {t(`attn.${a.msg.key}`, a.msg.values)}
                      {a.surface === "mcp" && <ProvenanceChip surface="mcp" name={null} />}
                    </span>
                    <Link href={a.href} aria-label={t("attn.openAria", { link: t(`attn.link.${linkKey(a.key)}`) })} className={linkClass}>
                      {t(`attn.link.${linkKey(a.key)}`)}
                    </Link>
                  </li>
                ))}
                {approved.map((c) => (
                  <li key={c.id} className="flex flex-col gap-1 py-2 text-sm">
                    <span className="flex items-center gap-2 text-foreground">
                      <Pill tone="good">{t("approvedPill")}</Pill> {t("approvedLine", { line: setLine(c) })}
                    </span>
                    {writesOff && (
                      <>
                        <span className="text-bad">
                          <span className="font-mono">google_writes_disabled</span>: {t("writesDisabled")}
                        </span>
                        <span className="text-xs text-muted-foreground">{t("applyWhenOn")}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={t("performance")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {simulated ? <Pill>{t("sampleData")}</Pill> : <span />}
              <Link href={`/performance?ws=${encodeURIComponent(`l:${id}`)}`} className={linkClass}>
                {t("openPerformance")}
              </Link>
            </div>
            {!perf.ok ? (
              <ErrorText message={`${perf.error.code}: ${perf.error.message}`} />
            ) : !s?.hasData ? (
              <p className="text-sm text-muted-foreground">{t("noPerformance")}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                {KPIS.map((k) => {
                  const kpi = s.kpis.find((x) => x.key === k.key);
                  const series = s.series.find((x) => x.key === k.key)?.points.map((p) => p.value) ?? [];
                  const up = (kpi?.delta ?? 0) >= 0;
                  return (
                    <div key={k.key} className="flex flex-col gap-1 rounded-control border border-border p-3">
                      <span className="text-xs font-semibold text-muted-foreground">{t(`kpi.${k.key}`)}</span>
                      <span className="flex items-center gap-2">
                        <span className="font-display text-xl font-extrabold tabular-nums">{kpi?.total ?? 0}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${up ? "bg-good-bg text-good" : "bg-bad-bg text-bad"}`}>
                          {deltaText(kpi?.deltaPct ?? null)}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">{t("vsBefore")}</span>
                      <Sparkline values={series} up={up} />
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title={t("recentActivity")}>
            {o.activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noActivity")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {o.activity.map((e, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <span className="w-44 shrink-0 tabular-nums text-muted-foreground">{tf.dateTime(e.at, ws)}</span>
                    <span className="text-foreground">{e.text}</span>
                    {e.surface === "mcp" && <ProvenanceChip surface="mcp" name={null} />}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel title={t("profileGlance")}>
            {!g?.profile ? (
              <p className="text-sm text-muted-foreground">{g ? t("profileUnreadable") : t("notRead")}</p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t("primaryCategory")}</dt>
                <dd className="text-foreground">{g.profile.primaryCategory ? plainText(g.profile.primaryCategory) : "–"}</dd>
                <dt className="text-muted-foreground">{t("hours")}</dt>
                <dd className="text-foreground">{hoursLine(g.profile.hoursToday, g.profile.openNow)}</dd>
                <dt className="text-muted-foreground">{t("phone")}</dt>
                <dd className="text-foreground">{g.profile.phone ?? "–"}</dd>
                <dt className="text-muted-foreground">{t("website")}</dt>
                <dd className="min-w-0 truncate">
                  {g.profile.website ? (
                    <a href={g.profile.website} className={linkClass} rel="noreferrer noopener" target="_blank">
                      {g.profile.website}
                    </a>
                  ) : (
                    "–"
                  )}
                </dd>
              </dl>
            )}
            {canEdit && (
              <Link href={`${base}/profile`} className={linkClass}>
                {t("editProfile")}
              </Link>
            )}
          </Panel>

          <Panel title={t("photosPanel")}>
            {!g?.photos ? (
              <p className="text-sm text-muted-foreground">{g ? t("photosUnreadable") : t("notRead")}</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {t("photoCount", { count: g.photos.count })}
                  {g.photos.newestDays !== null ? ` · ${t("photoNewest", { days: g.photos.newestDays })}` : ""}
                </p>
                <ul className="grid grid-cols-4 gap-2">
                  {g.photos.items.map((p, i) => (
                    <li key={i} className="flex aspect-square items-center justify-center overflow-hidden rounded-control bg-muted text-[10px] font-semibold text-muted-foreground">
                      {p.thumbnailUrl ? (
                        // Google-hosted, not stable: a plain img, as media-manager.tsx does (its line 37).
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.thumbnailUrl} alt={t("photoAlt", { category: enumLabel(p.category ?? "Uncategorised") })} className="size-full object-cover" />
                      ) : (
                        enumLabel(p.category ?? "Photo")
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {canEdit && (
              <Link href={`${base}/media`} className={linkClass}>
                {t("addPhotos")}
              </Link>
            )}
          </Panel>

          <Panel title={t("publicPage")} description={t("publicPageDesc")}>
            <LocationPagePanel locationId={id} published={pageInfo?.published ?? false} path={pageInfo?.published ? pageInfo.path : null} canManage={canManage} />
          </Panel>

          <AiVisibilityPanel locationId={id} canManage={can("geogrid:manage")} />

          <Panel title={t("bookingLink")}>
            {!g?.bookingLinks ? (
              <p className="text-sm text-muted-foreground">{g ? t("linksUnreadable") : t("notRead")}</p>
            ) : g.bookingLinks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noBooking")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {g.bookingLinks.map((k) => (
                  <li key={k.uri}>
                    {bookingTypeLabel(k.type)} ·{" "}
                    <a href={k.uri} className={linkClass} rel="noreferrer noopener" target="_blank">
                      {k.uri}
                    </a>
                    {k.preferred ? ` ${t("preferred")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
