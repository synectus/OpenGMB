import { getTranslations } from "next-intl/server";
import type {
  geogridCompetitors,
  geogridConfigsList,
  geogridRunsGet,
  geogridRunsList,
  geogridSettingsGet,
} from "@opengmb/core";
import {
  geogrid_competitors,
  geogrid_configs_list,
  geogrid_runs_get,
  geogrid_runs_list,
  geogrid_settings_get,
} from "../../app/_generated/actions";
import { defaultRunId, geogridHref, monthLine } from "../../lib/rank-tracking";
import { EmptyState, ErrorText } from "../ui";
import { NotLiveNote } from "./badges";
import { getTimeFormat } from "../../lib/time-format-server";
import { RunDetail } from "./run-detail";
import { RunHistory } from "./run-history";
import { TrackerList } from "./tracker-list";
import { EmptyNext } from "../empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const err = (r: { error: { code: string; message: string } }) => `${r.error.code}: ${r.error.message}`;

export async function TrackersView({
  configParam,
  runParam,
  canManage,
  canCost,
  apiKey,
  missingKeyHint,
  sample,
}: {
  configParam: string | undefined;
  runParam: string | undefined;
  canManage: boolean;
  canCost: boolean;
  apiKey: string | null;
  missingKeyHint: string;
  sample: boolean;
}) {
  const t = await getTranslations("geogrid");
  const tc = await getTranslations("geogridCost");
  const tf = await getTimeFormat();
  const [cfgRes, setRes] = await Promise.all([
    geogrid_configs_list(),
    canCost ? geogrid_settings_get() : Promise.resolve(null),
  ]);
  if (!cfgRes.ok) return <ErrorText message={err(cfgRes)} />;
  const configs = (cfgRes.data as Handler<typeof geogridConfigsList>).configs;
  const settings = setRes?.ok ? (setRes.data as Handler<typeof geogridSettingsGet>) : null;
  const selected = configs.find((c) => c.id === configParam) ?? configs[0] ?? null;

  const runsRes = selected ? await geogrid_runs_list({ configId: selected.id, limit: 200 }) : null;
  const runs = runsRes?.ok ? (runsRes.data as Handler<typeof geogridRunsList>).runs : [];
  const runId =
    (runParam && runs.some((r) => r.id === runParam) ? runParam : null) ??
    (selected ? defaultRunId(runs, selected.favoriteKeywords) : null);
  const [detailRes, compRes] = runId
    ? await Promise.all([
        geogrid_runs_get({ runId }),
        geogrid_competitors({ runId, includeTarget: true }),
      ])
    : [null, null];
  const detail = detailRes?.ok ? (detailRes.data as Handler<typeof geogridRunsGet>) : null;
  const competitors = compRes?.ok ? (compRes.data as Handler<typeof geogridCompetitors>).competitors : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        {settings && <p className="text-sm text-foreground">{monthLine(settings, t, tc)}</p>}
        {sample && <NotLiveNote>{t("trackers.notConnected")}</NotLiveNote>}
      </div>

      {configs.length === 0 ? (
        <EmptyNext id="rank-tracking" href={geogridHref({ view: "new" })} noLink={!canManage} ask={t("trackers.askCreate")} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <section aria-label={t("trackers.heading")} className="flex flex-col gap-3">
            <h2 className="font-display text-base font-bold text-foreground">{t("trackers.heading")}</h2>
            <TrackerList trackers={configs} selectedId={selected?.id ?? null} canManage={canManage} sample={sample} />
          </section>
          <div className="flex min-w-0 flex-col gap-5">
            {runsRes && !runsRes.ok && <ErrorText message={err(runsRes)} />}
            {detailRes && !detailRes.ok && <ErrorText message={err(detailRes)} />}
            {selected && detail ? (
              <RunDetail
                config={selected}
                detail={detail}
                runs={runs}
                competitors={competitors}
                apiKey={apiKey}
                missingKeyHint={missingKeyHint}
                tf={tf}
              />
            ) : selected ? (
              <EmptyState title={t("trackers.noRuns")}>
                <p>{t("trackers.previewThenRun")}</p>
                {selected.nextRunAt && (
                  <p className="mt-2">
                    <strong>{t("trackers.scheduledLead")}</strong> {t("trackers.firstRun", { when: tf.dateTime(selected.nextRunAt, selected.workspaceId) })}
                  </p>
                )}
              </EmptyState>
            ) : null}
            {selected && runs.length > 0 && (
              <RunHistory configId={selected.id} workspaceId={selected.workspaceId} runs={runs} currentId={runId} tf={tf} chargedLabel={canCost ? tc("history.charged") : undefined} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
