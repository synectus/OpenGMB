"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { reviews_sync, reviews_syncStatus } from "../app/_generated/actions";
import { ErrorText, secondaryButtonClass } from "./ui";

const POLL_MS = 1500;
const POLL_TRIES = 40;

export function SyncLocationButton({ workspaceId, locationId }: { workspaceId: string; locationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const r = await reviews_sync({ workspaceId, locationIds: [locationId] });
    if (!r.ok) {
      setBusy(false);
      return setError(`${r.error.code}: ${r.error.message}`);
    }
    const syncIds = (r.data as { syncs: { syncId: string }[] }).syncs.map((s) => s.syncId);
    for (let i = 0; i < POLL_TRIES && syncIds.length > 0; i++) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      const st = await reviews_syncStatus({ syncIds });
      if (!st.ok) {
        setError(`${st.error.code}: ${st.error.message}`);
        break;
      }
      const list = (st.data as { syncs: { status: string; error: string | null }[] }).syncs;
      const failed = list.find((s) => s.status === "failed");
      if (failed) setError(`${failed.error ?? "failed"}: The sync did not finish.`);
      if (list.every((s) => s.status !== "pending")) break;
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <button type="button" className={secondaryButtonClass} disabled={busy} onClick={start}>
        {busy ? "Syncing…" : "Sync reviews now"}
      </button>
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for the worker
        </p>
      )}
      <ErrorText message={error} />
    </div>
  );
}
