import Link from "next/link";
import { useTranslations } from "next-intl";
import { CheckCircle2, Link2 } from "lucide-react";
import { ConnectGoogleButton } from "../connect-google-button";
import { ConnectSampleGoogleButton } from "../connect-sample-google-button";
import { CreateWorkspaceForm } from "../create-workspace-form";
import { setupLine, waitingText, type Queue, type Step } from "../../lib/home";
import { SetupProgress } from "./setup";
import { TryAgain } from "./try-again";
import { buttonClass, secondaryButtonClass } from "../ui";

const card = "flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card";

export function NewAccount({ steps }: { steps: Step[] }) {
  const t = useTranslations("home");
  return (
    <section aria-labelledby="new-h" className={card}>
      <h2 id="new-h" className="font-display text-lg font-bold text-foreground">{t("state.newTitle", { n: steps.length })}</h2>
      <p className="text-sm text-muted-foreground">
        {t("state.newText")}
      </p>
      <CreateWorkspaceForm />
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
        {steps.map((s, i) => (
          <li key={s.title} className={i === 0 ? "font-semibold text-foreground" : ""}>{s.title}</li>
        ))}
      </ol>
    </section>
  );
}

export function ConnectGoogle({ steps, canConnect, sampleAvailable }: { steps: Step[]; canConnect: boolean; sampleAvailable: boolean }) {
  const t = useTranslations("home");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SetupProgress steps={steps} />
        <p className="text-sm text-muted-foreground">{setupLine(steps, t)}</p>
      </div>
      <section className={`${card} sm:flex-row sm:items-start`}>
        <Link2 aria-hidden className="size-6 shrink-0 text-brand" />
        <div className="flex flex-col gap-2">
          <strong className="text-foreground">{t("state.connectTitle")}</strong>
          <p className="text-sm text-muted-foreground">
            {t("state.connectText")}
          </p>
          {canConnect ? (
            <>
              <ConnectGoogleButton />
              {sampleAvailable && <ConnectSampleGoogleButton />}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("state.askAdmin")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

export function NoLocations({ anyInactive, steps }: { anyInactive: boolean; steps: Step[] }) {
  const t = useTranslations("home");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SetupProgress steps={steps} />
        <p className="text-sm text-muted-foreground">{setupLine(steps, t)}</p>
      </div>
      <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-input bg-card px-6 py-10 text-center">
        <p className="font-display font-bold text-foreground">{anyInactive ? t("state.noActive") : t("state.noLocations")}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {anyInactive
            ? t("state.noActiveText")
            : t("state.noLocationsText")}
        </p>
        <Link href={anyInactive ? "/locations" : "/locations/import"} className={`${buttonClass} mt-2`}>
          {anyInactive ? t("state.openLocations") : t("state.importLocations")}
        </Link>
      </div>
    </div>
  );
}

export function AllClear({ active, synced }: { active: number; synced: string }) {
  const t = useTranslations("home");
  return (
    <section className={`${card} items-center py-10 text-center`}>
      <CheckCircle2 aria-hidden className="size-8 text-good" />
      <strong className="font-display text-lg text-foreground">{t("state.clearTitle")}</strong>
      <p className="max-w-lg text-sm text-muted-foreground">
        {t("state.clearText", { n: active, synced: synced.charAt(0).toUpperCase() + synced.slice(1) })}
      </p>
      <div className="flex gap-2">
        <Link href="/performance" className={secondaryButtonClass}>{t("state.seePerformance")}</Link>
      </div>
    </section>
  );
}

export function RelinkNotes({ relink }: { relink: Queue["relink"] }) {
  const t = useTranslations("home");
  if (relink.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {relink.map((r) => (
        <li key={r.workspaceId} className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
          <code className="font-mono">connection_removed</code>: {t("state.relink", { n: r.locations, name: r.workspaceName })}{" "}
          <Link href="/settings/google" className="font-semibold underline">{t("state.googleConnection")}</Link>
        </li>
      ))}
    </ul>
  );
}

export function HomeSkeleton() {
  const t = useTranslations("home");
  return (
    <div className="flex flex-col gap-4">
      <p className="sr-only" role="status">{t("loading")}</p>
      <div aria-hidden className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[1, 2, 3, 4, 5, 6].map((k) => (
          <div key={k} className="flex h-24 flex-col gap-2 rounded-panel border border-border bg-card p-4">
            <span className="h-6 w-1/3 animate-pulse rounded bg-muted" />
            <span className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <div aria-hidden className="flex flex-col gap-2">
        {[1, 2, 3].map((k) => (
          <div key={k} className="h-14 animate-pulse rounded-panel border border-border bg-muted" />
        ))}
      </div>
    </div>
  );
}

export function QueueError({ code, message }: { code: string; message: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-panel border border-bad-border bg-bad-bg px-4 py-3 text-sm text-bad">
      <span className="flex-1">
        <code className="font-mono">{code}:</code> {message}
      </span>
      <TryAgain />
    </div>
  );
}

/** Approved replies not on Google yet: apart from the "needs you" total, never hidden by an all-clear. */
export function WaitingToPublish({ n, writesOff }: { n: number; writesOff: boolean }) {
  const t = useTranslations("home");
  if (n === 0) return null;
  return (
    <p role="status" className="rounded-control border border-border bg-muted px-3 py-2 text-sm text-foreground">
      {waitingText(n, writesOff, t)}{" "}
      <Link href="/reviews?view=queue&qstatus=approved" className="font-semibold underline">{t("state.approvedReplies")}</Link>
    </p>
  );
}
