"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  locations_import,
  locations_importStatus,
  locations_listAvailable,
} from "../app/_generated/actions";
import { importResultLabel, importResultTone, locationLabel } from "../lib/locations";
import { buttonClass, ErrorText, linkClass, secondaryButtonClass } from "./ui";

type Available = {
  accountName: string;
  displayName: string;
  truncated: boolean;
  locations: {
    locationName: string;
    title: string;
    phone: string | null;
    addressSummary: string | null;
    hasVoiceOfMerchant: boolean | null;
    alreadyImported: boolean;
    needsRelink: boolean;
    importedWorkspace: { name: string } | null;
  }[];
}[];
type Result = { locationName: string; result: string };

const POLL_MS = 1500;
const POLL_TRIES = 40;

const TONE = {
  good: "bg-good-bg text-good",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
  neutral: "bg-muted text-foreground",
} as const;

function InfoRow({ children }: { children: string }) {
  return (
    <p role="status" className="flex items-center gap-2 rounded-control bg-info-bg px-3 py-2 text-sm text-info">
      <svg aria-hidden viewBox="0 0 24 24" className="size-4 animate-spin" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
      {children}
    </p>
  );
}

export function ImportLocations({
  workspaceId,
  connections,
  max,
}: {
  workspaceId: string;
  connections: { id: string; email: string }[];
  max: number;
}) {
  const t = useTranslations("locations");
  const router = useRouter();
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [available, setAvailable] = useState<Available | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({}); // locationName -> accountName
  const [titles, setTitles] = useState<Record<string, string>>({}); // locationName -> title
  const [results, setResults] = useState<Result[] | null>(null);
  const [queued, setQueued] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hideUnverified, setHideUnverified] = useState(false);

  const fail = (e: { code: string; message: string }) => setError(`${e.code}: ${e.message}`);
  const titleOf = (name: string) => titles[name] ?? name;

  async function load() {
    setBusy(true);
    setLoading(true);
    setError(null);
    setResults(null);
    const r = await locations_listAvailable({ connectionId });
    setBusy(false);
    setLoading(false);
    if (!r.ok) return fail(r.error);
    const accounts = (r.data as { accounts: Available }).accounts;
    setAvailable(accounts);
    setTitles(Object.fromEntries(accounts.flatMap((a) => a.locations.map((l) => [l.locationName, l.title]))));
    setPicked({});
    setHideUnverified(false);
  }

  // Only a definite false counts as unverified; unknown (null) rows are never hidden.
  const unverified = (l: { hasVoiceOfMerchant: boolean | null }) => l.hasVoiceOfMerchant === false;
  const unverifiedCount = (available ?? []).reduce((n, a) => n + a.locations.filter(unverified).length, 0);
  function toggleHideUnverified(on: boolean) {
    setHideUnverified(on);
    if (!on || !available) return;
    const hidden = new Set(available.flatMap((a) => a.locations.filter(unverified).map((l) => l.locationName)));
    setPicked((p) => Object.fromEntries(Object.entries(p).filter(([name]) => !hidden.has(name))));
  }

  async function doImport() {
    setBusy(true);
    setError(null);
    const names = Object.keys(picked);
    setQueued(names);
    const r = await locations_import({
      connectionId,
      workspaceId,
      locations: Object.entries(picked).map(([locationName, accountName]) => ({ accountName, locationName })),
    });
    if (!r.ok) {
      setBusy(false);
      setQueued(null);
      return fail(r.error);
    }
    const { importId } = r.data as { importId: string };
    for (let i = 0; i < POLL_TRIES; i++) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      const s = await locations_importStatus({ importId });
      if (!s.ok) {
        fail(s.error);
        break;
      }
      const d = s.data as { status: string; results: Result[] | null; error: string | null };
      if (d.status === "done") {
        setResults(d.results);
        setAvailable(null);
        break;
      }
      if (d.status === "failed") {
        setError(t("importFailed", { error: d.error ?? "" }));
        break;
      }
      if (i === POLL_TRIES - 1) setError(t("stillImporting"));
    }
    setBusy(false);
    setQueued(null);
    router.refresh();
  }

  if (connections.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>{t("connectNote")}</p>
        <Link href="/settings/google" className={linkClass}>
          {t("connectGoogle")}
        </Link>
      </div>
    );
  }

  const count = Object.keys(picked).length;
  const note = { text: count > max ? t("pickUpTo", { max }) : t("selectedUpTo", { count, max }), over: count > max };
  const resultKnown = ["imported", "already_imported", "relinked", "exists_inactive", "conflict", "not_found"];
  const resultText = (r: string) => (resultKnown.includes(r) ? t(`result_${r}` as "result_imported") : importResultLabel(r));
  const pickerNoteText = (l: { alreadyImported: boolean; needsRelink: boolean; importedWorkspace: { name: string } | null }) => {
    if (!l.alreadyImported) return "";
    if (l.needsRelink) return t("pickerImportedNeedsRelink", { client: l.importedWorkspace?.name ?? "" });
    return l.importedWorkspace ? t("pickerAlreadyImported", { client: l.importedWorkspace.name }) : t("pickerOtherOrg");
  };
  const fresh = (results ?? [])
    .filter((r) => r.result === "imported" || r.result === "relinked")
    .map((r) => titleOf(r.locationName));
  const queuedText =
    fresh.length === 0
      ? null
      : fresh.length === 1
        ? t("queuedOne", { title: fresh[0]! })
        : t("queuedMany", { titles: fresh.join(", ") });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm font-semibold text-foreground">
          {t("googleAccount")}
          <select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            className="min-h-(--control-h) rounded-control border border-input bg-card px-3 text-sm font-normal focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.email}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={secondaryButtonClass} onClick={load} disabled={busy}>
          {t("loadLocations")}
        </button>
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          {["w-4/5", "w-2/3", "w-3/4"].map((w) => (
            <div key={w} aria-hidden className={`h-4 ${w} animate-pulse rounded bg-muted`} />
          ))}
          <InfoRow>{t("readingFromGoogle")}</InfoRow>
        </div>
      )}

      {available && unverifiedCount > 0 && (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" className="accent-primary" checked={hideUnverified} onChange={(e) => toggleHideUnverified(e.target.checked)} />
          {t("hideUnverified", { count: unverifiedCount })}
        </label>
      )}

      {available?.map((a) => (
        <fieldset key={a.accountName} className="flex flex-col gap-1 rounded-control border border-border p-3 text-sm">
          <legend className="px-1 font-semibold text-foreground">{t("loadedLine", { account: a.displayName, count: a.locations.length })}</legend>
          {a.locations.filter((l) => !(hideUnverified && unverified(l))).map((l) => {
            const disabled = l.alreadyImported && !l.needsRelink;
            return (
              <label key={l.locationName} className={`flex items-start gap-2 py-1 ${disabled ? "text-muted-foreground" : "text-foreground"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  disabled={disabled}
                  checked={l.locationName in picked}
                  onChange={(e) => {
                    const next = { ...picked };
                    if (e.target.checked) next[l.locationName] = a.accountName;
                    else delete next[l.locationName];
                    setPicked(next);
                  }}
                />
                <span>
                  {locationLabel(l)}
                  {pickerNoteText(l)}
                  {unverified(l) && (
                    <span title={t("notVerifiedTitle")} className="ml-2 rounded-control bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn">
                      {t("notVerified")}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {a.truncated && <p className="text-warn">{t("moreExist")}</p>}
        </fieldset>
      ))}

      {available && (
        <div className="flex flex-col gap-2">
          {note.over && (
            <p role="status" className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
              {note.text}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={buttonClass} disabled={busy || count === 0 || note.over} onClick={doImport}>
              {t("importSelected", { count })}
            </button>
            <span className="text-sm text-muted-foreground">{note.over ? t("selectedCount", { count }) : note.text}</span>
          </div>
        </div>
      )}

      {queued && (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1 text-sm" aria-label={t("importProgress")}>
            {queued.map((n) => (
              <li key={n} className={`rounded-control px-3 py-1.5 ${TONE.neutral}`}>
                {t("queuedItem", { title: titleOf(n) })}
              </li>
            ))}
          </ul>
          <InfoRow>{t("waitingWorker")}</InfoRow>
        </div>
      )}

      <ErrorText message={error} />

      {results && (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1 text-sm" aria-label={t("importResults")}>
            {results.map((r) => (
              <li key={r.locationName} className={`rounded-control px-3 py-1.5 ${TONE[importResultTone(r.result)]}`}>
                <span className="font-semibold">{titleOf(r.locationName)}:</span> {resultText(r.result)}
              </li>
            ))}
          </ul>
          {queuedText && <p className="text-sm text-muted-foreground">{queuedText}</p>}
        </div>
      )}
    </div>
  );
}
