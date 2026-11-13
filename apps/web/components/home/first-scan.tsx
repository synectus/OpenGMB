"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { geogrid_preview, geogrid_quickScans_create } from "../../app/_generated/actions";
import { FIRST_SCAN, firstScanHref, firstScanInput, type FirstScanChoice } from "../../lib/first-scan";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

// geogrid.preview is asked for the standard speed, so estimateUsd is that speed's price. Not rank-tracking.ts: it would pull the geogrid messages into Home.
const dollars = (n: number) => (n > 0 && n < 0.005 ? "less than $0.01" : `$${n.toFixed(2)}`);
const label = "flex flex-col gap-1 text-sm font-semibold text-foreground";

/** Home before Google is connected: find your own business on Google Maps and scan it, paid from the trial credit. */
export function FirstScanCard({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("home.firstScan");
  const router = useRouter();
  const [choices, setChoices] = useState<FirstScanChoice[] | null>(null);
  const [picked, setPicked] = useState<FirstScanChoice | null>(null);
  const [keyword, setKeyword] = useState("");
  const [priced, setPriced] = useState<{ estimateUsd: number; wouldExceed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    void geogrid_preview({ driverId: "dataforseo_standard", gridSize: FIRST_SCAN.gridSize, keywordCount: 1, speed: FIRST_SCAN.speed }).then(
      (r) => live && setPriced(r.ok ? (r.data as { estimateUsd: number; wouldExceed: boolean }) : null),
    );
    return () => {
      live = false;
    };
  }, []);

  async function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const query = String(new FormData(e.currentTarget).get("query") ?? "").trim();
    if (query.length < 2) return;
    setError(null);
    setPicked(null);
    setBusy(true);
    try {
      const res = await fetch("/api/tools/review-link/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json().catch(() => ({}))) as { choices?: FirstScanChoice[] };
      if (!res.ok) return setError(t("unavailable"));
      setChoices(j.choices ?? []);
      if ((j.choices ?? []).length === 0) setError(t("noMatch"));
    } catch {
      setError(t("unavailable"));
    } finally {
      setBusy(false);
    }
  }

  async function onScan(e: FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setPending(true);
    setError(null);
    const r = await geogrid_quickScans_create(firstScanInput(workspaceId, picked, keyword));
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    const out = r.data as { scan: { id: string }; runs: { runId: string }[] };
    router.push(firstScanHref(out.scan.id, out.runs[0]?.runId));
    router.refresh();
  }

  return (
    <section aria-labelledby="first-scan-h" className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 id="first-scan-h" className="font-display text-lg font-bold text-foreground">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">{t("text")}</p>
      <form onSubmit={onSearch} aria-label={t("search")} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className={`${label} flex-1`}>
          {t("businessLabel")}
          <input name="query" required minLength={2} maxLength={200} className={inputClass} />
        </label>
        <button type="submit" className={secondaryButtonClass} disabled={busy}>
          {busy ? t("searching") : t("search")}
        </button>
      </form>
      {choices && choices.length > 0 && (
        <form onSubmit={onScan} aria-label={t("scan")} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-semibold text-foreground">{t("choices")}</legend>
            {choices.map((c) => (
              <label key={c.placeId} className="flex items-start gap-2 text-sm text-foreground">
                <input type="radio" name="place" checked={picked?.placeId === c.placeId} onChange={() => setPicked(c)} className="mt-1" />
                <span>{c.name}, {c.address}</span>
              </label>
            ))}
          </fieldset>
          <label className={label}>
            {t("keyword")}
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} required maxLength={120} placeholder={t("keywordHint")} className={inputClass} />
          </label>
          {priced && <p role="status" className="text-sm text-muted-foreground">{t("cost", { cost: dollars(priced.estimateUsd) })}</p>}
          {priced?.wouldExceed && <p role="alert" className="text-sm font-semibold text-bad">{t("exceeds")}</p>}
          <div>
            <button type="submit" className={buttonClass} disabled={pending || !picked || !priced || priced.wouldExceed}>
              {pending ? t("working") : t("scan")}
            </button>
          </div>
        </form>
      )}
      <ErrorText message={error} />
    </section>
  );
}
