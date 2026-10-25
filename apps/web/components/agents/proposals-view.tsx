import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { MCP_CONFIG, type mcpProposalsList } from "@opengmb/core";
import { mcp_proposals_list } from "../../app/_generated/actions";
import {
  PROPOSAL_FILTERS,
  agentsHref,
  expiryLabel,
  madeLabel,
  policyLine,
  previewRows,
  proposalError,
  proposalTitle,
  type AgentsT,
  type ProposalFilter,
} from "../../lib/agents";
import type { TimeFormat } from "../../lib/time-format";
import { getTimeFormat } from "../../lib/time-format-server";
import { PillLinks, StatusBadge, TableWrap, tdClass, thClass } from "../page-parts";
import { EmptyState, ErrorText } from "../ui";
import { ProposalActions } from "./proposal-actions";

type Proposal = Awaited<ReturnType<typeof mcpProposalsList.handler>>["proposals"][number];

export async function ProposalsView({
  filter,
  selectedId,
  pendingCount,
  writesLive,
}: {
  filter: ProposalFilter;
  selectedId: string | undefined;
  pendingCount: number | null;
  writesLive: boolean;
}) {
  const t = await getTranslations("agents");
  const tp: AgentsT = (key, values) => t(`proposals.${key}`, values);
  const res = await mcp_proposals_list(filter === "all" ? { limit: 50 } : { status: filter, limit: 50 });
  if (!res.ok) return <ErrorText message={`${res.error.code}: ${res.error.message}`} />;
  const list = (res.data as { proposals: Proposal[] }).proposals;
  const selected = list.find((p) => p.proposalId === selectedId) ?? list[0] ?? null;
  const tf = await getTimeFormat();
  const now = new Date().getTime(); // not Date.now(): react-hooks/purity rejects it in a component
  const ttlMin = MCP_CONFIG.proposalTtlMs / 60_000;

  return (
    <div className="flex flex-col gap-3">
      <PillLinks
        label={t("filterLabel")}
        items={PROPOSAL_FILTERS.map((f) => ({
          href: agentsHref({ view: "proposals", status: f.key }),
          label: f.key === "pending" && pendingCount ? `${t(`filters.${f.key}`)} (${pendingCount})` : t(`filters.${f.key}`),
          current: f.key === filter,
        }))}
      />
      <p className="text-sm text-muted-foreground">
        {tp("onlyYours", { ttlMin })}
      </p>

      {list.length === 0 ? (
        <EmptyState title={filter === "pending" || filter === "all" ? tp("noneYet") : tp("nothingHere")}>
          {filter === "pending" || filter === "all"
            ? tp("noneYetBody")
            : tp("tryFilter")}
        </EmptyState>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-[1.4_1_560px]">
            <TableWrap>
              <table className="w-full min-w-[600px] text-left text-sm">
                <caption className="sr-only">{tp("tableCaption")}</caption>
                <thead className="border-b border-border bg-muted">
                  <tr>
                    <th scope="col" className={thClass}>{tp("colProposal")}</th>
                    <th scope="col" className={thClass}>{tp("colToken")}</th>
                    <th scope="col" className={thClass}>{tp("colMade")}</th>
                    <th scope="col" className={thClass}>{tp("colExpires")}</th>
                    <th scope="col" className={thClass}>{tp("colStatus")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.map((p) => {
                    const current = p.proposalId === selected?.proposalId;
                    const exp = expiryLabel(p.status, p.expiresAt, now, tf, (mins) => tp("inMin", { mins }));
                    return (
                      <tr key={p.proposalId} className={current ? "bg-brand-tint" : undefined}>
                        <td className={tdClass}>
                          <Link
                            href={agentsHref({ view: "proposals", status: filter, proposal: p.proposalId })}
                            aria-current={current ? "true" : undefined}
                            className={`font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                              p.status === "pending" || p.status === "applied"
                                ? "text-foreground"
                                : "text-muted-foreground"
                            }`}
                          >
                            {proposalTitle(p.action, p.preview, tp)}
                          </Link>
                        </td>
                        <td className={`${tdClass} text-foreground`}>{p.tokenName}</td>
                        <td className={`${tdClass} tabular-nums`}>{madeLabel(p.createdAt, now, tf)}</td>
                        <td className={`${tdClass} tabular-nums ${exp.soon ? "font-bold text-warn" : ""}`}>
                          {exp.text}
                        </td>
                        <td className={tdClass}>
                          <StatusBadge status={p.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </div>
          {selected && <ProposalDetail p={selected} now={now} writesLive={writesLive} tf={tf} />}
        </div>
      )}
    </div>
  );
}

function ProposalDetail({ p, now, writesLive, tf }: { p: Proposal; now: number; writesLive: boolean; tf: TimeFormat }) {
  const t = useTranslations("agents");
  const tp: AgentsT = (key, values) => t(`proposals.${key}`, values);
  const policy = policyLine(p.preview, tp);
  const err = proposalError(p.error);
  return (
    <section
      aria-label={tp("selected")}
      className="flex min-w-0 flex-[1_1_380px] flex-col gap-3.5 rounded-panel border border-border bg-card p-5 shadow-card"
    >
      <h2 className="font-display text-lg font-bold">{proposalTitle(p.action, p.preview, tp)}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={p.status} />
        <span className="inline-flex h-6 items-center rounded-md border border-agent-border bg-agent-bg px-2 text-xs font-semibold text-agent">
          {tp("madeBy", { name: p.tokenName })}
        </span>
        {p.tokenRevoked && <StatusBadge status="disabled" label={tp("tokenRevoked")} />}
      </div>
      <p className="text-sm text-muted-foreground">
        {tp("madeExpires", { made: tf.dateTime(p.createdAt), expires: tf.time(p.expiresAt) })}
      </p>

      <div>
        <h3 className="mb-2 text-sm font-bold">{tp("willDo")}</h3>
        <TableWrap>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted">
              <tr>
                <th scope="col" className={thClass}>{tp("colField")}</th>
                <th scope="col" className={thClass}>{tp("colValue")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {previewRows(p.action, p.preview, tp).map((r) => (
                <tr key={r.field}>
                  <th scope="row" className={`${tdClass} font-semibold text-foreground`}>{r.field}</th>
                  <td className={`${tdClass} break-all ${r.mono ? "font-mono" : ""}`}>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </div>

      {p.status === "pending" && (
        <p className={`text-sm font-semibold ${policy.ok ? "text-good" : "text-bad"}`}>{policy.text}</p>
      )}
      {p.status === "pending" && !writesLive && (
        <p role="note" className="rounded-control border border-warn-border bg-warn-bg px-3 py-2.5 text-sm text-foreground">
          {t.rich("proposals.writesOff", { code: (chunks) => <code className="font-mono">{chunks}</code> })}
        </p>
      )}
      {err && (
        <p role="alert" className="text-sm font-medium text-bad">
          <code className="font-mono">{err.code}</code>: {err.message}
        </p>
      )}
      {p.status === "applied" && p.appliedAt && (
        <p className="text-sm text-muted-foreground">{tp("applied", { when: tf.dateTime(p.appliedAt) })}</p>
      )}
      {p.status === "expired" && (
        <p className="text-sm text-muted-foreground">
          {tp("expired", { when: expiryLabel("expired", p.expiresAt, now, tf).text })}
        </p>
      )}
      {p.status === "cancelled" && (
        <p className="text-sm text-muted-foreground">{tp("cancelled")}</p>
      )}
      {p.status === "pending" && (
        <ProposalActions proposalId={p.proposalId} canApply={!p.tokenRevoked} />
      )}
    </section>
  );
}
