import type { aiVisibilityGet } from "@opengmb/core";
import { Sparkline } from "../locations/sparkline";
import { Panel } from "../ui";
import { aiVisibility_get } from "../../app/_generated/actions";
import { AiVisibilitySettingsForm } from "./settings-form";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type Data = Handler<typeof aiVisibilityGet>;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const SAMPLE = "Sample data. Nothing here is from a real search.";

/** AI search visibility for one location (K5): how often ChatGPT, Gemini, Perplexity and Google AI Overviews name the business, week by week. */
export async function AiVisibilityPanel({ locationId, canManage }: { locationId: string; canManage: boolean }) {
  const r = await aiVisibility_get({ locationId });
  if (!r.ok) return null;
  const d = r.data as Data;
  const rows = Object.entries(d.engineLabels).filter(([key]) => d.settings.engines.includes(key as never));
  const latest = d.latest;
  const sample = latest?.dataSource === "fixture" || latest?.dataSource === "sandbox";
  return (
    <Panel
      title="AI search visibility"
      description="How often ChatGPT, Gemini, Perplexity and Google AI Overviews name this business when someone asks for the best one nearby."
    >
      {!d.settings.enabled && !latest && <p className="text-sm text-muted-foreground">Off. Nothing is checked or charged until you switch it on.</p>}
      {d.trend.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map(([key, label]) => {
            const rates = d.trend.flatMap((p) => (p.engines[key] ? [p.engines[key].rate] : []));
            const last = d.trend.at(-1)?.engines[key];
            const prev = rates.length > 1 ? rates[rates.length - 2]! : null;
            const now = rates.at(-1);
            return (
              <li key={key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-control border border-border p-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                <span className="text-sm font-semibold text-foreground">{label}</span>
                <span className="text-right text-sm tabular-nums text-foreground sm:order-3">
                  {last ? `${pct(last.rate)} (${last.mentioned} of ${last.answered})` : "No answer"}
                </span>
                <div className="col-span-2 sm:order-2 sm:col-span-1">
                  <Sparkline values={rates} up={prev === null || now === undefined || now >= prev} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {latest && (
        <>
          <p className="text-xs text-muted-foreground">
            Last check {latest.date}. {d.trend.length > 1 ? `Trend over the last ${d.trend.length} checks.` : "The trend appears after the next weekly check."}
            {sample ? ` ${SAMPLE}` : ""}
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-foreground">Businesses named instead of, or with, yours</h3>
            {latest.competitors.length === 0 ? (
              <p className="text-sm text-muted-foreground">No competitor from your rank tracking was named in the latest answers.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {latest.competitors.slice(0, 8).map((c) => (
                  <li key={c.name} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words text-foreground">{c.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{c.mentions === 1 ? "1 answer" : `${c.mentions} answers`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold text-foreground">What each one said</summary>
            <ul className="mt-2 flex flex-col gap-2">
              {latest.results.map((x, i) => (
                <li key={i} className="rounded-control bg-muted p-2">
                  <p className="font-medium text-foreground">
                    {d.engineLabels[x.engine]}: {x.prompt}
                  </p>
                  <p className="text-muted-foreground">
                    {x.error ? "No answer" : x.mentioned ? `Names you${x.position ? `, number ${x.position}` : ""}` : "Does not name you"}
                  </p>
                  {x.excerpt && <p className="mt-1 break-words text-muted-foreground">{x.excerpt}</p>}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <AiVisibilitySettingsForm
        locationId={locationId}
        enabled={d.settings.enabled}
        category={d.settings.category}
        city={d.settings.city}
        engines={d.settings.engines}
        engineLabels={d.engineLabels}
        chargedUsd={d.estimate?.chargedUsd ?? null}
        canManage={canManage}
      />
    </Panel>
  );
}
