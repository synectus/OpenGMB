"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { performance_backfill } from "../app/_generated/actions";
import { secondaryButtonClass } from "./ui";

const POLL_MS = 3000;
const POLL_TRIES = 20;

/**
 * Queue a full re-fetch of one location's performance history, then refresh the page while it
 * lands. Reads from Google only, so it works while Google writes are off.
 */
export function PerformanceRefresh({
  locationId,
  months,
}: {
  /** null when the scope holds more than one location: the button is shown disabled. */
  locationId: string | null;
  months: number;
}) {
  const t = useTranslations("performance");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!locationId) return;
    setBusy(true);
    setError(null);
    const r = await performance_backfill({ locationId });
    if (!r.ok) {
      setError(t("refreshFailed", { detail: `${r.error.code}: ${r.error.message}` }));
      setBusy(false);
      return;
    }
    for (let i = 0; i < POLL_TRIES; i++) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={secondaryButtonClass} disabled={busy || !locationId} onClick={start}>
        {busy ? t("fetching") : t("refresh")}
      </button>
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("waiting", { months })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
