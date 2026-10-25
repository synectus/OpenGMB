"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { aiVisibility_runNow, aiVisibility_update } from "../../app/_generated/actions";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

type Props = {
  locationId: string;
  enabled: boolean;
  category: string;
  city: string;
  engines: string[];
  engineLabels: Record<string, string>;
  /** What one weekly check costs the organization; null when the role cannot see costs. */
  chargedUsd: number | null;
  canManage: boolean;
};

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** Switch AI search visibility on or off for one location, with the weekly cost shown before it is switched on. */
export function AiVisibilitySettingsForm({ locationId, enabled, category, city, engines, engineLabels, chargedUsd, canManage }: Props) {
  const router = useRouter();
  const [cat, setCat] = useState(category);
  const [town, setTown] = useState(city);
  const [picked, setPicked] = useState<string[]>(engines);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: boolean) {
    setBusy(true);
    setNote(null);
    const r = await aiVisibility_update({ locationId, enabled: next, category: cat, city: town, engines: picked.length ? (picked as never) : undefined });
    setBusy(false);
    if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
    else {
      setError(null);
      router.refresh();
    }
  }
  async function checkNow() {
    setBusy(true);
    const r = await aiVisibility_runNow({ locationId });
    setBusy(false);
    if (!r.ok) setError(`${r.error.code}: ${r.error.message}`);
    else {
      setError(null);
      setNote("Check queued. The answers appear here in a minute or two.");
    }
  }
  if (!canManage) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
          Type of business
          <input className={inputClass} value={cat} maxLength={80} placeholder="dentist" onChange={(e) => setCat(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
          City
          <input className={inputClass} value={town} maxLength={80} placeholder="Austin" onChange={(e) => setTown(e.target.value)} />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <legend className="mb-1 font-medium text-foreground">Where to check</legend>
        {Object.entries(engineLabels).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-foreground">
            <input type="checkbox" checked={picked.includes(key)} onChange={(e) => setPicked(e.target.checked ? [...picked, key] : picked.filter((k) => k !== key))} />
            {label}
          </label>
        ))}
      </fieldset>
      {chargedUsd !== null && (
        <p className="text-sm text-muted-foreground">
          Each weekly check costs about {usd(chargedUsd)} with the places saved here, taken from your credit and counted in your monthly budget. It is off until you switch it on.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {enabled ? (
          <>
            <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => save(true)}>
              Save changes
            </button>
            <button type="button" disabled={busy} className={secondaryButtonClass} onClick={checkNow}>
              Check now
            </button>
            <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => save(false)}>
              Switch off
            </button>
          </>
        ) : (
          <button type="button" disabled={busy || !cat.trim() || !town.trim()} className={buttonClass} onClick={() => save(true)}>
            Switch on weekly checks
          </button>
        )}
      </div>
      {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
      <ErrorText message={error} />
    </div>
  );
}
