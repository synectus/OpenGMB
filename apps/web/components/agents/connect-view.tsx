import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { MCP_CONFIG, type apiTokensList } from "@opengmb/core";
import { apiTokens_list } from "../../app/_generated/actions";
import { claudeDesktopConfig, mcpCommand, mcpUrlFrom } from "../../lib/mcp-connect";
import { getTimeFormat } from "../../lib/time-format-server";
import { CreateTokenForm } from "../create-token-form";
import { Pill, TableWrap, tdClass, thClass } from "../page-parts";
import { EmptyState, ErrorText, Panel, linkClass } from "../ui";
import { CopyButton } from "./copy-button";

type Listed = Awaited<ReturnType<typeof apiTokensList.handler>>;

const PROMPT_KEYS = ["prompt1", "prompt2", "prompt3"] as const;

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5 rounded-xl border border-border bg-card p-4">
      <span
        aria-hidden
        className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-tint font-extrabold text-brand-text"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <strong className="text-[15px]">{title}</strong>
        {children}
      </div>
    </li>
  );
}

export async function ConnectView({
  userId,
  readOnlyOnly,
  showSettingNames,
}: {
  userId: string;
  readOnlyOnly: boolean;
  showSettingNames: boolean;
}) {
  const t = await getTranslations("agents");
  const tc = (key: string, values?: Record<string, string | number>) => t(`connect.${key}`, values);
  const url = mcpUrlFrom(process.env);
  const res = await apiTokens_list();
  const mine = res.ok ? (res.data as Listed).tokens.filter((tk) => tk.ownerUserId === userId) : [];
  const tf = await getTimeFormat();
  const ttlMin = MCP_CONFIG.proposalTtlMs / 60_000;

  return (
    <>
      <Panel title={tc("stepsTitle")}>
        <ol className="flex flex-col gap-3">
          <Step n={1} title={tc("step1")}>
            <CreateTokenForm readOnlyOnly={readOnlyOnly} mcpUrl={url} />
            <p className="text-sm text-muted-foreground">
              {tc("readOnlyNote")}
            </p>
          </Step>
          <Step n={2} title={tc("step2")}>
            {url ? (
              <>
                <pre
                  aria-label={tc("mcpCommand")}
                  className="m-0 whitespace-pre-wrap break-all rounded-control border border-border bg-muted px-4 py-3 font-mono text-[13px] leading-5"
                >
                  {mcpCommand(url)}
                </pre>
                <div className="flex flex-wrap items-center gap-3">
                  <CopyButton text={mcpCommand(url)} label={tc("copyCommand")} />
                  <span className="text-sm text-muted-foreground">
                    {tc("worksWith")}
                  </span>
                </div>
                <strong className="text-sm">{tc("desktopTitle")}</strong>
                <pre
                  aria-label={tc("desktopTitle")}
                  className="m-0 overflow-x-auto rounded-control border border-border bg-muted px-4 py-3 font-mono text-[13px] leading-5"
                >
                  {claudeDesktopConfig(url)}
                </pre>
                <p className="text-sm text-muted-foreground">{tc("desktopNote")}</p>
              </>
            ) : (
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Pill tone="warn">{tc("notLive")}</Pill>
                {tc("noAddress")}{" "}
                {showSettingNames ? tc("settingName") : tc("askOwner")}
              </p>
            )}
          </Step>
          <Step n={3} title={tc("step3")}>
            <ul aria-label={tc("examplePrompts")} className="flex flex-wrap gap-2.5">
              {PROMPT_KEYS.map((k) => (
                <li
                  key={k}
                  className="flex-[1_1_240px] rounded-control border border-border bg-muted px-3.5 py-3 text-foreground"
                >
                  &ldquo;{tc(k)}&rdquo;
                </li>
              ))}
            </ul>
          </Step>
        </ol>
      </Panel>

      <Panel title={tc("canDoTitle")}>
        <div className="flex flex-wrap gap-3.5">
          <div className="flex flex-[1_1_320px] flex-col gap-2.5 rounded-xl border border-agent-border bg-agent-bg p-4">
            <strong className="text-[15px] text-agent">{tc("toApprovals")}</strong>
            <ul className="list-disc pl-5 text-foreground">
              <li>{tc("replyDrafts")}</li>
              <li>{tc("posts")}</li>
              <li>{tc("profileChanges")}</li>
            </ul>
            <span className="inline-flex h-6 items-center self-start rounded-md border border-agent-border bg-card px-2 text-xs font-semibold text-agent">
              {tc("draftedChip")}
            </span>
            <span className="text-sm text-muted-foreground">
              {tc("draftsNote", { chip: tc("draftedChip") })}
            </span>
          </div>
          <div className="flex flex-[1_1_320px] flex-col gap-2.5 rounded-xl border border-border bg-muted p-4">
            <strong className="text-[15px]">{tc("asksFirst")}</strong>
            <ul className="list-disc pl-5 text-foreground">
              <li>{tc("bookingLinks")}</li>
              <li>{tc("photos")}</li>
              <li>{tc("rankTrackers")}</li>
              <li>{tc("groups")}</li>
              <li>{tc("imports")}</li>
            </ul>
            <span className="text-sm text-muted-foreground">
              {tc("proposalNote", { ttlMin })}
            </span>
          </div>
        </div>
        <p className="text-sm text-foreground">
          {tc("guardrails")}
        </p>
      </Panel>

      <Panel title={tc("tokensTitle")}>
        <div>
          <Link href="/settings/tokens" className={linkClass}>
            {tc("manageTokens")}
          </Link>
        </div>
        {!res.ok ? (
          <ErrorText message={`${res.error.code}: ${res.error.message}`} />
        ) : mine.length === 0 ? (
          <EmptyState title={tc("emptyTitle")}>
            {tc("emptyBody")}
          </EmptyState>
        ) : (
          <TableWrap>
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-border bg-muted">
                <tr>
                  <th scope="col" className={thClass}>{tc("colName")}</th>
                  <th scope="col" className={thClass}>{tc("colAccess")}</th>
                  <th scope="col" className={thClass}>{tc("colLastUsed")}</th>
                  <th scope="col" className={thClass}>{tc("colStatus")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {mine.map((tk) => (
                  <tr key={tk.id} className={tk.revokedAt ? "text-muted-foreground" : undefined}>
                    <th scope="row" className={`${tdClass} font-bold`}>{tk.name}</th>
                    <td className={tdClass}>{tk.scopes.includes("write") ? tc("readWrite") : tc("readOnly")}</td>
                    <td className={`${tdClass} tabular-nums`}>
                      {tk.lastUsedAt ? tf.dateTime(tk.lastUsedAt) : tc("never")}
                    </td>
                    <td className={tdClass}>
                      {tk.revokedAt ? <Pill>{tc("revoked")}</Pill> : <Pill tone="good">{tc("active")}</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>
    </>
  );
}
