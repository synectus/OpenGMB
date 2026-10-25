import { getTranslations } from "next-intl/server";
import { aiUsage_get } from "../../app/_generated/actions";
import { ErrorText } from "../ui";
import { AiCapForm } from "./ai-cap-form";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Staff-only (review:configure): this month's AI spend per client against each cap. Server rendered. */
export async function AiUsagePanel({ workspaceId, workspaceName }: { workspaceId?: string; workspaceName?: string }) {
  const t = await getTranslations("aiCost");
  const r = await aiUsage_get({});
  if (!r.ok) return <ErrorText message={`${r.error.code}: ${r.error.message}`} />;
  const d = r.data as {
    month: string;
    aiOn: boolean;
    clients: { workspaceId: string; name: string; spentUsd: number; capUsd: number | null; calls: number }[];
    platform: { spentUsd: number; capUsd: number } | null;
  };
  const selected = d.clients.find((c) => c.workspaceId === workspaceId);
  return (
    <section className="flex flex-col gap-2.5 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-lg font-bold">{t("title")}</h2>
      {!d.aiOn && <p className="text-sm font-medium text-bad">{t("off")}</p>}
      <p className="text-sm text-muted-foreground">{t("month", { month: d.month })}</p>
      {d.platform && (
        <p className="text-sm">{t("platform", { spent: usd(d.platform.spentUsd), cap: usd(d.platform.capUsd) })}</p>
      )}
      {d.clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("title")}</caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("client")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("spent")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("cap")}</th>
                <th scope="col" className="py-1.5 font-medium">{t("calls")}</th>
              </tr>
            </thead>
            <tbody>
              {d.clients.map((c) => (
                <tr key={c.workspaceId} className="border-b border-border last:border-0">
                  <th scope="row" className="py-1.5 pr-3 font-medium">{c.name}</th>
                  <td className="py-1.5 pr-3">{usd(c.spentUsd)}</td>
                  <td className="py-1.5 pr-3">{c.capUsd === null ? t("noCap") : usd(c.capUsd)}</td>
                  <td className="py-1.5">{c.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && workspaceName && (
        <AiCapForm
          key={`${selected.workspaceId}|${selected.capUsd}`}
          workspaceId={selected.workspaceId}
          initialUsd={selected.capUsd}
          labels={{
            cap: t("capLabel", { name: workspaceName }),
            hint: t("capHint"),
            save: t("save"),
            saving: t("saving"),
            saved: t("saved"),
          }}
        />
      )}
    </section>
  );
}
