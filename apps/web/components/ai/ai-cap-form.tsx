"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { aiUsage_setClientCap } from "../../app/_generated/actions";
import { buttonClass, ErrorText, inputClass } from "../ui";

/** Staff-only. Every string comes in as a prop from the server (aiCost is not sent to the browser). */
export function AiCapForm({
  workspaceId,
  initialUsd,
  labels,
}: {
  workspaceId: string;
  initialUsd: number | null;
  labels: { cap: string; hint: string; save: string; saving: string; saved: string };
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialUsd === null ? "" : String(initialUsd));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const n = value.trim() === "" ? null : Number(value);
    if (n !== null && (!Number.isFinite(n) || n < 0)) return setError(labels.hint);
    setPending(true);
    setError(null);
    const r = await aiUsage_setClientCap({ workspaceId, monthlyCapUsd: n });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm font-medium">
        {labels.cap}
        <input
          className={inputClass}
          inputMode="decimal"
          value={value}
          disabled={pending}
          onChange={(e) => {
            setSaved(false);
            setValue(e.target.value);
          }}
        />
        <span className="text-xs font-normal text-muted-foreground">{labels.hint}</span>
      </label>
      <ErrorText message={error} />
      <div className="flex items-center gap-3">
        <button type="submit" className={buttonClass} disabled={pending}>
          {pending ? labels.saving : labels.save}
        </button>
        {saved && <span className="text-sm text-good" role="status">{labels.saved}</span>}
      </div>
    </form>
  );
}
