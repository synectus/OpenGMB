"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { suspension_cases_create, suspension_cases_update } from "../app/_generated/actions";
import {
  CASE_TONE,
  caseButtons,
  doneLabels,
  type CaseData,
} from "../lib/suspension";
import { AgentProposalNote } from "./agent-proposal-note";
import { Pill } from "./page-parts";
import { runCall } from "./post-card";
import { useTimeFormat } from "./time-format-provider";
import { buttonClass, inputClass, secondaryButtonClass } from "./ui";

export type { CaseData };

function CodeError({ message }: { message: string | null }) {
  if (!message) return null;
  const at = message.indexOf(":");
  return (
    <p role="alert" className="text-[13px] text-bad">
      <span className="font-mono">{message.slice(0, at)}</span>
      {message.slice(at)}
    </p>
  );
}

function CaseCard({ initial, canEdit }: { initial: CaseData; canEdit: boolean }) {
  const router = useRouter();
  const t = useTranslations("locationHub.susp");
  const tf = useTimeFormat();
  const [c, setC] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(c.outcomeNotes ?? "");
  const can = caseButtons(c.status);
  const day = (iso: string) => tf.date(iso, c.workspaceId);
  const status = t(`status.${c.status}`);
  const waiting = c.status === "appealed" && c.appealSubmittedAt ? t("waiting", { date: day(c.appealSubmittedAt) }) : null;
  const meta = [
    t("opened", { date: day(c.openedAt) }),
    c.appealSubmittedAt ? t("appealSubmitted", { date: day(c.appealSubmittedAt) }) : t("appealNotSubmitted"),
    ...(c.outcomeAt ? [t("outcome", { date: day(c.outcomeAt) })] : []),
    t("evidence", { done: c.checklistDone, total: c.checklistTotal }),
  ].join(" | ");

  async function update(input: object) {
    setBusy(true);
    setError(null);
    const r = await runCall<{ case: CaseData }>(() => suspension_cases_update({ id: c.id, ...input }));
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setC(r.data.case);
    router.refresh();
  }

  return (
    <section
      aria-label={can.notes ? t("finishedAria", { status }) : t("openAria")}
      className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={CASE_TONE[c.status]}>{status}</Pill>
        <span className="text-[13px] tabular-nums text-muted-foreground">{meta}</span>
      </div>
      {c.status === "open" && <p className="text-sm">{c.reason}</p>}
      {waiting && <p role="status" className="text-[13px] text-info">{waiting}</p>}

      {can.checklist ? (
        <>
          <ul aria-label={t("checklistAria")} className="flex flex-col divide-y divide-border">
            {c.evidenceChecklist.map((i) => (
              <li key={i.key} className="flex flex-wrap items-center gap-3 py-2">
                <label className="flex min-w-60 flex-1 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={i.done}
                    disabled={busy || !canEdit}
                    onChange={(e) => update({ checklist: [{ key: i.key, done: e.target.checked }] })}
                  />
                  {i.label}
                </label>
                {canEdit ? (
                  <input
                    aria-label={t("noteFor", { label: i.label })}
                    defaultValue={i.note}
                    disabled={busy}
                    placeholder={t("notePlaceholder")}
                    className={`${inputClass} min-w-56 flex-1`}
                    onBlur={(e) => {
                      if (e.target.value !== i.note) void update({ checklist: [{ key: i.key, note: e.target.value }] });
                    }}
                  />
                ) : (
                  <span className="text-[13px] text-muted-foreground">{i.note || t("noNote")}</span>
                )}
              </li>
            ))}
          </ul>
          {canEdit && <p className="text-xs text-muted-foreground">{t("notesSave")}</p>}
        </>
      ) : (
        doneLabels(c).length > 0 && (
          <ul aria-label={t("checklistReadOnly")} className="flex flex-col gap-1 text-[13px]">
            {doneLabels(c).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )
      )}

      <CodeError message={error} />
      {canEdit && (can.appeal || can.outcome) && (
        <div className="flex flex-wrap gap-2">
          {can.appeal && (
            <button type="button" className={buttonClass} disabled={busy} onClick={() => update({ status: "appealed" })}>
              {t("markAppeal")}
            </button>
          )}
          {can.outcome && (
            <>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => update({ status: "reinstated" })}>
                {t("reinstated")}
              </button>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => update({ status: "closed_lost" })}>
                {t("closedLost")}
              </button>
            </>
          )}
        </div>
      )}
      {can.notes && canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm font-medium">
            {t("outcomeNotes")}
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
          </label>
          <button type="button" className={secondaryButtonClass} disabled={busy || notes === (c.outcomeNotes ?? "")}
            onClick={() => update({ outcomeNotes: notes })}>
            {t("saveNotes")}
          </button>
        </div>
      )}
      {can.notes && !canEdit && c.outcomeNotes && <p className="text-sm">{c.outcomeNotes}</p>}
    </section>
  );
}

export function SuspensionManager({
  locationId,
  canEdit,
  cases,
}: {
  locationId: string;
  canEdit: boolean;
  cases: CaseData[];
}) {
  const router = useRouter();
  const t = useTranslations("locationHub.susp");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {cases.map((c) => (
        <CaseCard key={c.id} initial={c} canEdit={canEdit} />
      ))}
      {cases.length === 0 && (
        <div className="rounded-panel border border-dashed border-input bg-card px-6 py-8 text-center text-sm text-muted-foreground">
          {t("noCases")}
        </div>
      )}
      {!canEdit && <p className="text-sm text-muted-foreground">{t("viewOnly")}</p>}
      {canEdit && (
        <section aria-label={t("openACase")} className="flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p)">
          <h2 className="font-display text-base font-bold">{t("openACase")}</h2>
          <form
            className="flex flex-col gap-2"
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              const problem = reason.trim() ? null : t("reasonProblem");
              if (problem) return setError(problem);
              setBusy(true);
              setError(null);
              const r = await runCall(() => suspension_cases_create({ locationId, reason }));
              setBusy(false);
              if ("error" in r) return setError(r.error);
              setReason("");
              router.refresh();
            }}
          >
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t("whatHappened")}
              <textarea
                rows={3}
                maxLength={4000}
                value={reason}
                aria-invalid={error?.startsWith("INVALID_INPUT") || undefined}
                onChange={(e) => setReason(e.target.value)}
                className={`${inputClass} min-h-20 py-2`}
              />
            </label>
            <CodeError message={error} />
            <button type="submit" className={`${buttonClass} self-start`} disabled={busy}>
              {t("openCase")}
            </button>
          </form>
        </section>
      )}
      {canEdit && <AgentProposalNote what="new suspension cases and case updates" />}
    </div>
  );
}
