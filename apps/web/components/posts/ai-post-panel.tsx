"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ai_draftPost, ai_draftPostVariants, ai_postIdeas } from "../../app/_generated/actions";
import { approvalsHref } from "../../lib/approvals";
import { guardrailLabel } from "../../lib/labels";
import { useAiNotice } from "../ai-notice";
import { runCall } from "../post-card";
import { ErrorText, linkClass } from "../ui";

const small =
  "inline-flex h-[30px] items-center rounded-control border border-input bg-card px-2.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

type Ideas = { status: string; ideas: string[]; blockedRuleIds: string[] };
type Draft = { status: string; draft: string | null; blockedRuleIds: string[] };
type Variants = {
  results: { locationId: string; outcome: string; reason: string | null }[];
  counts: { drafted: number };
};

/**
 * AI help in the composer: five ideas for the first chosen location, "Write it" drops the full post into
 * the editor (nothing is saved), and for several locations one different post per location goes
 * straight to approval. All of it runs through the server's metering, caps and guardrails.
 */
export function AiPostPanel({
  workspaceId,
  locations,
  locationIds,
  disabled,
  hasText,
  onWrite,
}: {
  workspaceId: string;
  locations: { id: string; title: string }[];
  locationIds: string[];
  disabled: boolean;
  hasText: boolean;
  /** Put AI text in the editor as a Standard post. */
  onWrite(text: string): void;
}) {
  const tp = useTranslations("posts");
  const notice = useAiNotice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [sent, setSent] = useState<Variants | null>(null);
  const first = locationIds[0];
  const titleOf = (id: string) => locations.find((l) => l.id === id)?.title ?? id;

  async function suggest() {
    if (!first) return;
    if (!(await notice.ready())) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    const r = await runCall<Ideas>(() => ai_postIdeas({ workspaceId, locationId: first }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    if (r.data.status !== "ok") {
      return setError(tp("comp.ai.blocked", { rules: r.data.blockedRuleIds.map((id) => guardrailLabel(id)).join(", ") }));
    }
    setIdeas(r.data.ideas);
  }

  async function writeIt(idea: string | undefined) {
    if (!first) return;
    if (hasText && !window.confirm(tp("comp.ai.confirmReplace"))) return;
    if (!(await notice.ready())) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    const r = await runCall<Draft>(() => ai_draftPost({ workspaceId, locationId: first, ...(idea ? { idea } : {}) }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    if (r.data.status !== "ok" || r.data.draft === null) {
      return setError(tp("comp.ai.blocked", { rules: r.data.blockedRuleIds.map((id) => guardrailLabel(id)).join(", ") }));
    }
    onWrite(r.data.draft);
    setInfo(tp("comp.ai.filled"));
  }

  async function eachLocation() {
    if (!window.confirm(tp("comp.ai.confirmEach", { count: locationIds.length }))) return;
    if (!(await notice.ready())) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    setSent(null);
    const r = await runCall<Variants>(() => ai_draftPostVariants({ workspaceId, locationIds }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setSent(r.data);
  }

  const none = locationIds.length === 0;
  return (
    <section aria-label={tp("comp.ai.title")} className="flex flex-col gap-2.5 rounded-panel border border-border p-3.5">
      {notice.dialog}
      <h3 className="text-[13px] font-semibold text-foreground">{tp("comp.ai.title")}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={small} disabled={disabled || busy || none} onClick={suggest}>
          {tp("comp.ai.ideas")}
        </button>
        <button type="button" className={small} disabled={disabled || busy || none} onClick={() => writeIt(undefined)}>
          {tp("comp.ai.write")}
        </button>
        {locationIds.length > 1 && (
          <button type="button" className={small} disabled={disabled || busy} onClick={eachLocation}>
            {tp("comp.ai.each", { count: locationIds.length })}
          </button>
        )}
        {none && <span className="text-xs text-muted-foreground">{tp("comp.ai.pickLocation")}</span>}
        {busy && <span role="status" className="text-xs text-muted-foreground">{tp("comp.ai.working")}</span>}
      </div>
      {ideas.length > 0 && (
        <ul aria-label={tp("comp.ai.ideasList")} className="flex flex-col gap-1.5">
          {ideas.map((idea) => (
            <li key={idea} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">{idea}</span>
              <button type="button" className={small} disabled={disabled || busy} onClick={() => writeIt(idea)}>
                {tp("comp.ai.writeIt")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {info && <p role="status" className="text-xs text-muted-foreground">{info}</p>}
      <ErrorText message={error} />
      {sent && (
        <div role="status" className="flex flex-col gap-1.5 text-sm">
          <p>
            {tp("comp.ai.eachDone", { drafted: sent.counts.drafted, total: sent.results.length })}{" "}
            <Link className={linkClass} href={approvalsHref({ tab: "post", ws: workspaceId })}>
              {tp("comp.ai.openApprovals")}
            </Link>
          </p>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {sent.results.map((x) => (
              <li key={x.locationId}>
                {titleOf(x.locationId)}: {tp(`comp.ai.outcome.${x.outcome}`)}
                {x.reason && x.outcome !== "drafted" ? ` (${x.reason})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
