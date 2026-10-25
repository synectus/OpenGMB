"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { startOfZonedDay } from "@opengmb/core/time";
import { reviewNotes_add, reviews_assign } from "../../app/_generated/actions";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

export type Assignee = { userId: string; name: string };
export type InternalNote = { id: string; authorName: string; body: string; createdAt: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The calendar day after a `YYYY-MM-DD` key. */
function nextDay(key: string) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Team-only panel under a review: who is handling it, by when, and the internal notes. Nothing here
 * goes to Google or into a reply. A due date is a calendar day in the client's time zone; the review
 * counts as overdue once that day is over. `dueDay` is that day (YYYY-MM-DD) or "".
 */
export function AssignPanel({
  reviewId,
  zone,
  assignees,
  initialAssigneeId,
  initialDueDay,
  initialNotes,
  timeText,
}: {
  reviewId: string;
  zone: string;
  assignees: Assignee[];
  initialAssigneeId: string;
  initialDueDay: string;
  initialNotes: InternalNote[];
  /** Server-formatted "date time" for each note id, in the client's format. */
  timeText: Record<string, string>;
}) {
  const t = useTranslations("reviews");
  const router = useRouter();
  const [assignee, setAssignee] = useState(initialAssigneeId);
  const [dueDay, setDueDay] = useState(initialDueDay);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    const r = await reviews_assign({
      reviewId,
      assigneeUserId: assignee || null,
      dueAt: assignee && DAY.test(dueDay) ? startOfZonedDay(nextDay(dueDay), zone).toISOString() : null,
    });
    setBusy(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    setSaved(assignee ? t("assign.saved") : t("assign.removed"));
    router.refresh();
  }

  async function addNote() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    const r = await reviewNotes_add({ reviewId, body: text });
    setBusy(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    const n = (r.data as { note: InternalNote }).note;
    setNotes((all) => [...all, n]);
    setText("");
    router.refresh();
  }

  return (
    <section aria-label={t("assign.team")} className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-3">
      <h3 className="text-sm font-semibold">{t("assign.team")}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-[13px] text-muted-foreground">
          {t("assign.assignedTo")}
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className={inputClass}
          >
            <option value="">{t("assign.nobody")}</option>
            {assignees.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
          {t("assign.dueDate")}
          <input
            type="date"
            value={dueDay}
            disabled={!assignee}
            onChange={(e) => setDueDay(e.target.value)}
            className={inputClass}
          />
        </label>
        <button type="button" className={buttonClass} disabled={busy} onClick={save}>
          {t("assign.save")}
        </button>
      </div>
      {saved && <p role="status" className="text-sm text-muted-foreground">{saved}</p>}

      <div className="flex flex-col gap-2">
        <h4 className="text-[13px] font-semibold">{t("assign.internalNotes")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("assign.notesPrivate")}
        </p>
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("assign.noNotes")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg border border-border bg-card px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {n.authorName} · {timeText[n.id] ?? new Date(n.createdAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap text-sm">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
        <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
          {t("assign.addNoteLabel")}
          <textarea
            value={text}
            maxLength={2000}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            className={`${inputClass} w-full`}
          />
        </label>
        <div>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy || !text.trim()}
            onClick={addNote}
          >
            {t("assign.addNote")}
          </button>
        </div>
      </div>
      <ErrorText message={error} />
    </section>
  );
}
