import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { redirectClientHome } from "../../lib/client-home";
import { getTranslations } from "next-intl/server";
import { emailConfigured, isMockGoogleMode, roleHasPermission, type Role, integrationEnv } from "@opengmb/core";
import { actorContextFor } from "../../lib/auth";
import { requireUser } from "../../lib/guard";
import { resumePath } from "../../lib/sign-up-entry";
import { HIDDEN_SETUP_STEPS } from "../../lib/nav-private";
import { ageText, autoApproveText, homeMode, parseHomeSearch, setupSteps, syncedText, type Counts, type Queue, type TypeFilter } from "../../lib/home";
import { liveStatus } from "../../lib/live-status";
import type { Scope } from "../../lib/scope";
import { currentScope } from "../../lib/scope-server";
import { getTimeFormat } from "../../lib/time-format-server";
import { ClientMessages } from "../../components/client-messages";
import { AutoApproveChipView } from "../../components/auto-approve-chip-view";
import { AgencyHome, Tiles } from "../../components/home/agency-home";
import { OwnerHome } from "../../components/home/owner-home";
import { TrialWelcome } from "../../components/billing/trial";
import { AllClear, ConnectGoogle, HomeSkeleton, NewAccount, NoLocations, QueueError, RelinkNotes, WaitingToPublish } from "../../components/home/states";
import { PageHeader, secondaryButtonClass } from "../../components/ui";
import { attention_counts, attention_queue } from "../_generated/actions";

const QUEUE_LIMIT = 50;

type HomeProps = { searchParams: Promise<{ ws?: string; type?: string }> };

// The home namespaces are sent for this page only, not for the whole (app) shell.
export default function HomePage(props: HomeProps) {
  return (
    <ClientMessages set="home">
      <Home {...props} />
    </ClientMessages>
  );
}

async function Home({ searchParams }: HomeProps) {
  // Layouts do not re-run on every client navigation, so each page checks too.
  const { userId } = await requireUser();
  // Arrived through a link that still needs finishing (an invitation): do that before anything else.
  const resume = await resumePath();
  if (resume) redirect(resume);
  const { role, home } = await actorContextFor(userId);
  redirectClientHome(home);
  const sp = await searchParams;
  const { type } = parseHomeSearch(sp);
  const scope = await currentScope(sp.ws);
  const t = await getTranslations("home");
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <PageHeader title={t("title")} />
      <Suspense fallback={null}>
        <TrialWelcome role={role} />
      </Suspense>
      <Suspense fallback={<HomeSkeleton />}>
        <HomeBody scope={scope} type={type} role={role} />
      </Suspense>
    </div>
  );
}

async function HomeBody({ scope, type, role }: { scope: Scope; type: TypeFilter; role: Role }) {
  const t = await getTranslations("home");
  const tf = await getTimeFormat(scope.urlWs ?? undefined);
  const wsId = scope.workspaceId; // the queue and counts filter by workspace only
  const ws = scope.urlWs ?? null; // a ?ws= deep link survives the pills and tiles
  const input = wsId ? { workspaceId: wsId, limit: QUEUE_LIMIT } : { limit: QUEUE_LIMIT };
  // Two independent reads: one failing never blanks the page.
  const [queueRes, countsRes] = await Promise.all([
    attention_queue(input),
    attention_counts(wsId ? { workspaceId: wsId } : {}),
  ]);
  const now = new Date().getTime(); // not Date.now(): react-hooks/purity rejects it in a component
  const writesOff = liveStatus(integrationEnv(), emailConfigured()).rows.find((r) => r.key === "writes")?.state !== "live";
  if (!queueRes.ok) {
    return (
      <div className="flex flex-col gap-4">
        {countsRes.ok ? <Tiles counts={countsRes.data as Counts} ws={ws} writesOff={writesOff} /> : null}
        <QueueError code={queueRes.error.code} message={queueRes.error.message} />
      </div>
    );
  }
  const raw = queueRes.data as Queue;
  // The cards show only locations in scope; the setup checklist stays org-wide.
  const q: Queue = { ...raw, locations: raw.locations.filter((l) => scope.locationIds.includes(l.id)) };
  const mode = homeMode(q, scope.activeLocations);
  const steps = setupSteps(q.setup, t, HIDDEN_SETUP_STEPS);
  if (mode === "no_workspace") return <NewAccount steps={steps} />;
  if (mode === "no_google") return <ConnectGoogle steps={steps} canConnect={roleHasPermission(role, "google:manage")} sampleAvailable={isMockGoogleMode()} />;
  if (mode === "no_locations") return <NoLocations anyInactive={q.setup.locations > 0} steps={steps} />;

  const synced = syncedText(q.lastReviewSyncAt, ageText(q.lastReviewSyncAt, now, t), t);
  const chip = autoApproveText(q.autoApprove.map((a) => a.minStars as 4 | 5), t);
  const clients = wsId ? 1 : q.setup.workspaces;
  const meta =
    mode === "agency"
      ? t("meta.agency", { day: tf.day(tf.today(wsId), wsId), clients, active: scope.activeLocations, synced })
      : q.counts.total === 0
        ? t("meta.nothing")
        : t("meta.count", { n: q.counts.total });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{meta}</p>
        <div className="flex flex-wrap items-center gap-2">
          {chip && mode === "owner" ? <AutoApproveChipView text={chip} href="/settings/workspace" /> : null}
          {roleHasPermission(role, "review:draft") ? (
            <Link href="/posts?view=compose" className={secondaryButtonClass}>{t("newPost")}</Link>
          ) : null}
        </div>
      </div>
      <RelinkNotes relink={q.relink} />
      <WaitingToPublish n={q.counts.waitingToPublish} writesOff={writesOff} />
      {q.counts.total === 0 && mode === "agency" ? (
        <AllClear active={scope.activeLocations} synced={synced} />
      ) : mode === "agency" ? (
        <AgencyHome q={q} ws={ws} type={type} now={now} writesOff={writesOff} />
      ) : (
        <>
          {q.counts.total === 0 ? <AllClear active={scope.activeLocations} synced={synced} /> : null}
          <OwnerHome q={q} now={now} canDismiss={roleHasPermission(role, "google:manage")} />
        </>
      )}
    </div>
  );
}
