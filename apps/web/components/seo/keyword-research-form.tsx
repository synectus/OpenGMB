"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { seo_cities_search, seo_keywords_estimate, seo_keywords_research } from "../../app/_generated/actions";
import { priceLineText, researchErrorText, SEO_COUNTRIES, seoKeywordsHref, shortCity, type PriceEstimate, type SeoCountry } from "../../lib/seo-keywords";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

const label = "flex flex-col gap-1 text-sm font-semibold text-foreground";
const ROWS = [50, 150, 300];

type Estimate = PriceEstimate & { wouldExceed: boolean };
type CityOption = { locationName: string; locationType: string };


/** The search form for staff: seed, country, city, rows, the price before spend, and Run search. */
export function KeywordResearchForm({
  workspaces,
  workspaceId,
  defaultCountry,
  defaultCityQuery,
  locationId,
}: {
  workspaces: { id: string; name: string }[];
  workspaceId: string;
  defaultCountry: SeoCountry;
  defaultCityQuery: string;
  locationId?: string;
}) {
  const t = useTranslations("seoKeywords");
  const tc = useTranslations("seoKeywordsCost");
  const router = useRouter();
  const [ws, setWs] = useState(workspaceId);
  const [seed, setSeed] = useState("");
  const [country, setCountry] = useState<SeoCountry>(defaultCountry);
  const [cityText, setCityText] = useState(defaultCityQuery);
  const [city, setCity] = useState<string | null>(null);
  const [found, setFound] = useState<{ key: string; list: CityOption[] } | null>(null);
  const [rows, setRows] = useState(150);
  const [priced, setPriced] = useState<{ key: string; data: Estimate | null; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const cityKey = `${country}|${cityText.trim()}`;
  const priceKey = `${ws}|${seed.trim()}|${country}|${city ?? ""}|${rows}`;
  // Only answers that belong to what is typed now are shown.
  const options = city === null && found?.key === cityKey ? found.list : null;
  const settled = priced?.key === priceKey ? priced : null;
  const estimate = settled?.data ?? null;

  // City suggestions: 300 ms after the last keystroke, only for text the user has not yet picked.
  useEffect(() => {
    if (city !== null || cityKey.length < 3) return;
    const q = cityText.trim();
    let live = true;
    const id = setTimeout(() => {
      void seo_cities_search({ countryIso: country, query: q }).then((r) => {
        if (live) setFound({ key: cityKey, list: r.ok ? (r.data as { cities: CityOption[] }).cities : [] });
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [cityText, cityKey, city, country]);

  // The price, asked again whenever the query changes.
  useEffect(() => {
    if (seed.trim().length < 2) return;
    let live = true;
    const id = setTimeout(() => {
      void seo_keywords_estimate({ workspaceId: ws, seed, countryIso: country, city: city ?? undefined, rows }).then(
        (r) => live && setPriced(r.ok ? { key: priceKey, data: r.data as Estimate } : { key: priceKey, data: null, error: researchErrorText(r.error, tc) }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [ws, seed, country, city, rows, priceKey, attempt, tc]);

  function pick(o: CityOption) {
    setCity(o.locationName);
    setCityText(shortCity(o.locationName));
  }
  function clearCity() {
    setCity(null);
    setCityText("");
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    if (cityText.trim() && city === null) return setError(t("form.pickCity"));
    if (!estimate) return;
    setPending(true);
    const r = await seo_keywords_research({
      workspaceId: ws,
      locationId,
      seed,
      countryIso: country,
      city: city ?? undefined,
      rows,
      maxChargeUsd: estimate.chargedUsd,
    });
    setPending(false);
    if (!r.ok) return setError(researchErrorText(r.error, tc));
    const out = r.data as { runId: string };
    router.push(seoKeywordsHref({ ws, run: out.runId }));
    router.refresh();
  }

  return (
    <form aria-label={t("form.label")} onSubmit={submit} className="flex flex-col gap-4 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          {t("form.seed")}
          <input value={seed} onChange={(e) => setSeed(e.target.value)} required minLength={2} maxLength={80} placeholder={t("form.seedHint")} className={inputClass} />
        </label>
        <label className={label}>
          {t("form.country")}
          <select
            value={country}
            onChange={(e) => {
              setCountry(e.target.value as SeoCountry);
              clearCity();
            }}
            className={inputClass}
          >
            {SEO_COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {t(`countries.${c}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="relative flex flex-col gap-1">
          <label htmlFor="seo-city" className="text-sm font-semibold text-foreground">
            {t("form.city")}
          </label>
          <div className="flex gap-2">
            <input
              id="seo-city"
              role="combobox"
              aria-expanded={options !== null}
              aria-controls="seo-city-list"
              aria-autocomplete="list"
              autoComplete="off"
              value={cityText}
              onChange={(e) => {
                setCityText(e.target.value);
                setCity(null);
              }}
              className={`${inputClass} min-w-0 flex-1`}
            />
            {cityText && (
              <button type="button" className={secondaryButtonClass} onClick={clearCity}>
                {t("form.cityClear")}
              </button>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{t("form.cityHint")}</span>
          {options !== null && (
            <ul id="seo-city-list" role="listbox" aria-label={t("form.cityList")} className="absolute top-full z-10 mt-1 max-h-60 w-full overflow-auto rounded-control border border-border bg-card shadow-card">
              {options.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">{t("form.cityNone")}</li>
              ) : (
                options.map((o) => (
                  <li key={o.locationName} role="option" aria-selected={city === o.locationName}>
                    <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => pick(o)}>
                      {o.locationName}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        <label className={label}>
          {t("form.rows")}
          <select value={rows} onChange={(e) => setRows(Number(e.target.value))} className={inputClass}>
            {ROWS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {workspaces.length > 1 && (
        <label className={label}>
          {t("page.workspaceLabel")}
          <select value={ws} onChange={(e) => setWs(e.target.value)} className={inputClass}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="status" data-testid="price-line" aria-label={tc("price.label")} className="flex flex-col gap-1 text-sm">
          {estimate ? (
            <>
              <strong className="text-foreground">{priceLineText(estimate, tc)}</strong>
              {estimate.wouldExceed && <span className="font-semibold text-bad">{tc("price.exceed")}</span>}
            </>
          ) : settled?.error ? (
            <span className="flex flex-wrap items-center gap-2">
              <span role="alert" className="font-medium text-bad">
                {settled.error}
              </span>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => {
                  setPriced(null);
                  setAttempt((n) => n + 1);
                }}
              >
                {tc("price.retry")}
              </button>
            </span>
          ) : seed.trim().length >= 2 ? (
            <span className="text-muted-foreground">{tc("price.checking")}</span>
          ) : null}
        </div>
        <button type="submit" className={buttonClass} disabled={pending || !estimate || estimate.wouldExceed}>
          {pending ? t("form.running") : t("form.run")}
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}
