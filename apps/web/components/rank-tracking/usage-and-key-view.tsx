import { getTranslations } from "next-intl/server";
import type { geogridByoKeyGet, geogridSettingsGet, geogridUsage } from "@opengmb/core";
import { geogrid_byoKey_get, geogrid_settings_get, geogrid_usage } from "../../app/_generated/actions";
import { getTimeFormat } from "../../lib/time-format-server";
import { usageRows } from "../../lib/tracker-setup";
import { TableWrap, tdClass, thClass } from "../page-parts";
import { ErrorText } from "../ui";
import { BudgetPanel } from "./budget-panel";
import { OwnKeyPanel } from "./own-key-panel";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const err = (r: { error: { code: string; message: string } }) => `${r.error.code}: ${r.error.message}`;

export async function UsageAndKeyView({ canAdmin }: { canAdmin: boolean }) {
  const t = await getTranslations("geogrid");
  const tc = await getTranslations("geogridCost");
  const tf = await getTimeFormat();
  const to = tf.today();
  const [y, m] = to.split("-").map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 6, 1)).toISOString().slice(0, 10);
  const [setRes, usageRes, keyRes] = await Promise.all([
    geogrid_settings_get(),
    geogrid_usage({ from, to }),
    canAdmin ? geogrid_byoKey_get() : Promise.resolve(null),
  ]);
  const settings = setRes.ok ? (setRes.data as Handler<typeof geogridSettingsGet>) : null;
  const rows = usageRes.ok ? usageRows((usageRes.data as Handler<typeof geogridUsage>).months, t, tc) : [];
  const key = keyRes?.ok ? (keyRes.data as Handler<typeof geogridByoKeyGet>) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 lg:grid-cols-2">
        {settings ? <BudgetPanel settings={settings} canEdit={canAdmin} /> : !setRes.ok && <ErrorText message={err(setRes)} />}
        {key && <OwnKeyPanel keyState={key} />}
        {keyRes && !keyRes.ok && <ErrorText message={err(keyRes)} />}
      </div>
      <section aria-label={t("usage.label")} className="flex flex-col gap-2">
        <h2 className="font-display text-base font-bold text-foreground">{t("usage.heading")}</h2>
        {!usageRes.ok && <ErrorText message={err(usageRes)} />}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>
        ) : (
          <TableWrap>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted">
                <tr>
                  {(["month", "keyUsed", "runs", "points", "tasks", "costAt"] as const).map((h) => (
                    <th key={h} scope="col" className={thClass}>
                      {t(`usage.${h}`)}
                    </th>
                  ))}
                  <th scope="col" className={thClass}>
                    {tc("usage.charged")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={`${r.month}-${r.key}`}>
                    <td className={tdClass}>{r.month}</td>
                    <td className={tdClass}>{r.key}</td>
                    <td className={`${tdClass} tabular-nums`}>{r.runs}</td>
                    <td className={`${tdClass} tabular-nums`}>{r.points}</td>
                    <td className={`${tdClass} tabular-nums`}>{r.tasks}</td>
                    <td className={`${tdClass} tabular-nums`}>{r.cost}</td>
                    <td className={`${tdClass} tabular-nums`}>{r.charged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="text-xs text-muted-foreground">{tc("usage.note")}</p>
      </section>
    </div>
  );
}
