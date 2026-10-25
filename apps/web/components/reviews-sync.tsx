"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { reviews_sync, reviews_syncStatus } from "../app/_generated/actions";
import { buttonClass, ErrorText } from "./ui";

type SyncStatus = {
  id: string;
  locationName: string;
  status: "pending" | "done" | "failed";
  counts: { fetched: number; inserted: number; updated: number } | null;
  error: string | null;
};

const POLL_MS = 1500;
const POLL_TRIES = 40;

/** "Sync now" for one workspace: queue the syncs, then poll their status until none is pending. */
export function SyncNow({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const t = useTranslations("reviews");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncs, setSyncs] = useState<SyncStatus[]>([]);

  async function start() {
    setBusy(true);
    setError(null);
    setSyncs([]);
    const r = await reviews_sync({ workspaceId });
    if (!r.ok) {
      setBusy(false);
      setError(`${r.error.code}: ${r.error.message}`);
      return;
    }
    const syncIds = (r.data as { syncs: { syncId: string }[] }).syncs.map((s) => s.syncId);
    for (let i = 0; i < POLL_TRIES; i++) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      const st = await reviews_syncStatus({ syncIds });
      if (!st.ok) {
        setError(`${st.error.code}: ${st.error.message}`);
        break;
      }
      const list = (st.data as { syncs: SyncStatus[] }).syncs;
      setSyncs(list);
      if (list.every((s) => s.status !== "pending")) break;
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={start}>
          {busy ? t("sync.syncing") : t("sync.syncNow", { name: workspaceName })}
        </button>
      </div>
      <ErrorText message={error} />
      {syncs.length > 0 && (
        <ul className="text-sm text-muted-foreground" aria-live="polite">
          {syncs.map((s) => (
            <li key={s.id}>
              {s.locationName}:{" "}
              {s.status === "pending"
                ? t("sync.waiting")
                : s.status === "failed"
                  ? t("sync.failed", { error: s.error ?? t("sync.unknown") })
                  : t("sync.counts", {
                      fetched: s.counts?.fetched ?? 0,
                      inserted: s.counts?.inserted ?? 0,
                      updated: s.counts?.updated ?? 0,
                    })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
