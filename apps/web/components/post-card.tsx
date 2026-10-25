"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { postsGet } from "@opengmb/core";
import {
  posts_approve,
  posts_cancel,
  posts_deletePublished,
  posts_get,
  posts_reject,
  posts_schedule,
} from "../app/_generated/actions";
import { Violations } from "./reply-panel";
import { StatusBadge } from "./page-parts";
import { buttonClass, destructiveButtonClass, ErrorText, secondaryButtonClass } from "./ui";
import {
  cardState,
  describeSchedule,
  scheduleInput,
  locationsCell,
  targetRows,
  typeName,
  type ScheduleDraft,
  type Tone,
} from "../lib/posts-lists";
import { useTimeFormat } from "./time-format-provider";
import { SchedulePicker } from "./schedule-picker";
import { PublishedEdit } from "./posts/published-edit";
import { utcToWall } from "@opengmb/core/time";
import { sendTimeProblem } from "../lib/posts";

export type PostData = Awaited<ReturnType<(typeof postsGet)["handler"]>>["post"];
export type ActionResult =
  { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

const POLL_MS = 1500;
const POLL_TRIES = 40;
const field =
  "rounded-control border border-input bg-card px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring";

const TONE: Record<Tone, string> = {
  agent: "border-agent-border bg-agent-bg text-agent",
  plain: "border-border bg-muted text-secondary-foreground",
  warn: "border-warn-border bg-warn-bg text-warn",
  good: "border-good-border bg-good-bg text-good",
  bad: "border-bad-border bg-bad-bg text-bad",
  info: "border-info-border bg-info-bg text-info",
  neutral: "border-border bg-muted text-secondary-foreground",
};

/** Run one action: its data, or an error string for ErrorText. */
export async function runCall<T>(
  fn: () => Promise<ActionResult>,
): Promise<{ data: T } | { error: string }> {
  const r = await fn();
  return r.ok ? { data: r.data as T } : { error: `${r.error.code}: ${r.error.message}` };
}

/** Poll posts.get every 1.5s, at most 40 times, until done(post). Calls onPost with each fresh read. */
export async function pollPost(
  id: string,
  done: (p: PostData) => boolean,
  onPost: (p: PostData) => void,
) {
  for (let i = 0; i < POLL_TRIES; i++) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    const r = await runCall<{ post: PostData }>(() => posts_get({ id }));
    if ("error" in r) return;
    onPost(r.data.post);
    if (done(r.data.post)) return;
  }
}

type Mode = "now" | "at" | "recurring";

function ScheduleForm({
  post,
  busy,
  writesOff,
  locations,
  onSchedule,
}: {
  post: PostData;
  busy: boolean;
  writesOff: boolean;
  locations: number;
  onSchedule: (input: Record<string, unknown>) => void;
}) {
  const t = useTranslations("posts");
  const tf = useTimeFormat();
  const zone = tf.zone(post.workspaceId);
  // A time picked in Compose is kept on the draft: offer it, unless it has passed since.
  const picked = post.scheduledFor ? utcToWall(post.scheduledFor, zone) : "";
  const usable = picked !== "" && sendTimeProblem(t, picked, zone) === null;
  const [mode, setMode] = useState<Mode>(usable ? "at" : "now");
  const [at, setAt] = useState(usable ? picked : "");
  const [freq, setFreq] = useState("weekly");
  const [interval, setInterval] = useState(1);
  const [ends, setEnds] = useState<"until" | "count">("count");
  const [until, setUntil] = useState("");
  const [count, setCount] = useState(4);
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (mode !== "now") {
      const problem = sendTimeProblem(t, at, zone);
      if (problem) return setErr(problem);
    }
    const r = scheduleInput(
      t,
      { mode, at, freq: freq as "weekly" | "monthly", interval, ends, count, until },
      post.id,
      zone,
    );
    if ("error" in r) return setErr(r.error);
    onSchedule(r.input);
  }

  const draft: ScheduleDraft = {
    mode,
    at,
    freq: freq as "weekly" | "monthly",
    interval,
    ends,
    count,
    until,
    locations,
  };
  const sentence = describeSchedule(t, draft, tf, post.workspaceId);

  return (
    <fieldset className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-3 text-sm">
      <legend className="px-1 font-medium">{t("sched.whenToSend")}</legend>
      {(["now", "at", "recurring"] as const).map((m) => (
        <label key={m} className="flex items-center gap-2">
          <input
            type="radio"
            name={`mode-${post.id}`}
            checked={mode === m}
            onChange={() => setMode(m)}
          />
          {m === "now" ? t("sched.modeNow") : m === "at" ? t("sched.modeAt") : t("sched.modeRecurring")}
        </label>
      ))}
      {mode !== "now" && (
        <SchedulePicker
          label={mode === "recurring" ? t("sched.firstSend") : t("sched.sendAt")}
          value={at}
          onChange={setAt}
          workspaceId={post.workspaceId}
        />
      )}
      {mode === "recurring" && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            {t("sched.repeats")}
            <select className={field} value={freq} onChange={(e) => setFreq(e.target.value)}>
              <option value="weekly">{t("sched.weekly")}</option>
              <option value="monthly">{t("sched.monthly")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            {t("sched.everyN")}
            <input
              type="number"
              min={1}
              max={52}
              className={`${field} w-20`}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t("sched.endsBy")}
            <select
              className={field}
              value={ends}
              onChange={(e) => setEnds(e.target.value as "until" | "count")}
            >
              <option value="count">{t("sched.byCount")}</option>
              <option value="until">{t("sched.byDate")}</option>
            </select>
          </label>
          {ends === "count" ? (
            <label className="flex flex-col gap-1">
              {t("sched.totalSends")}
              <input
                type="number"
                min={2}
                max={366}
                className={`${field} w-24`}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
          ) : (
            <label className="flex flex-col gap-1">
              {t("sched.lastDay", { zone })}
              <input
                type="date"
                className={field}
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </label>
          )}
        </div>
      )}
      {sentence && <p className="text-[13px] text-muted-foreground">{sentence}</p>}
      {writesOff && (
        <p className="rounded-lg border border-warn-border bg-warn-bg px-3 py-2 text-[13px] text-warn">
          {t.rich("sched.writesOff", {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      )}
      <ErrorText message={err} />
      <div>
        <button type="button" className={buttonClass} disabled={busy} onClick={submit}>
          {t("sched.schedule")}
        </button>
      </div>
    </fieldset>
  );
}

/**
 * One post with its per-location results and the actions core allows (`post.can`, never the role).
 * Sending and deleting are asynchronous: after those the card polls posts.get until the worker settles.
 */
export function PostCard({
  initial,
  highlight = false,
  writesOff = false,
}: {
  initial: PostData;
  highlight?: boolean;
  writesOff?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("posts");
  const tf = useTimeFormat();
  const [post, setPost] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const can = post.can;

  /** Run an action that returns { post }; adopt the post, optionally poll, then refresh the page. */
  async function act(
    fn: () => Promise<ActionResult>,
    pollDone?: (p: PostData) => boolean,
    waiting?: string,
  ) {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await runCall<{ post?: PostData; sendQueued?: boolean; queued?: boolean }>(fn);
    if ("error" in r) {
      setBusy(false);
      return setError(r.error);
    }
    if (r.data.post) setPost(r.data.post);
    if (pollDone && (r.data.sendQueued || r.data.queued)) {
      setNote(waiting ?? t("card.waiting"));
      await pollPost(post.id, pollDone, setPost);
      setNote(null);
    } else if (!r.data.post) {
      const g = await runCall<{ post: PostData }>(() => posts_get({ id: post.id }));
      if ("data" in g) setPost(g.data.post);
    }
    setBusy(false);
    router.refresh();
  }

  const settled = (p: PostData) => p.status !== "publishing";
  const noPublished = (p: PostData) =>
    settled(p) && !p.targets.some((t) => t.status === "published");
  const view = cardState(t, post, tf);
  const rows = targetRows(post, tf);

  // A post that is already being sent when the page loads: poll until the worker settles it.
  useEffect(() => {
    if (initial.status === "publishing") void pollPost(initial.id, settled, setPost);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the post this card was keyed to
  }, []);

  return (
    <article
      className={`flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card ${highlight ? "border-foreground" : "border-border"}`}
      aria-label={t("card.aria", { id: post.id })}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-[22px] items-center rounded-md bg-secondary px-2 text-xs font-semibold text-secondary-foreground">
            {typeName(t, post.topicType)}
          </span>
          <StatusBadge status={post.status} />
          {view.meta && <span className="text-[13px] text-muted-foreground">{view.meta}</span>}
        </span>
        <span className="text-xs text-muted-foreground">{t("card.created", { date: tf.dateTime(post.createdAt, post.workspaceId) })}</span>
      </div>
      {view.provenance && (
        <p className={`rounded-lg border px-3 py-1.5 text-[13px] ${TONE[view.provenance.tone]}`}>
          {view.provenance.text}
        </p>
      )}
      <h2 className="font-display text-base font-bold leading-6">
        {post.event?.title || post.summary.split("\n")[0] || t("common.noText")}
      </h2>
      <p className="whitespace-pre-wrap text-sm">{post.summary || t("common.noText")}</p>
      {post.guardrail && post.guardrail.violations.length > 0 && (
        <Violations result={post.guardrail} />
      )}
      {view.note && (
        <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${TONE[view.note.tone]}`}>
          {view.note.text}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("card.resultsCaption")}</caption>
            <thead>
              <tr className="bg-muted text-xs text-muted-foreground">
                {(["colLocation", "colOccurrence", "colStatus", "colReason", "colGooglePost"] as const).map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-semibold">
                    {t(`card.${h}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">{row.location}</td>
                  <td className="px-3 py-2">{row.occurrence}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2 break-words">{row.reason}</td>
                  <td className="px-3 py-2">
                    {row.googleHref && (
                      <Link href={row.googleHref} className="text-sm font-semibold text-brand-text underline">
                        {t("common.viewOnGoogle")}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {post.status === "published" && (
        <PublishedEdit post={post} writesOff={writesOff} />
      )}

      {can.schedule && (
        <ScheduleForm
          post={post}
          busy={busy}
          writesOff={writesOff}
          locations={Number(locationsCell(t, post))}
          onSchedule={(input) =>
            act(() => posts_schedule(input), settled, t("card.publishingNote"))
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {can.edit && (
          <Link
            className="text-sm font-semibold text-brand-text underline"
            href={`/posts?view=compose&ws=${post.workspaceId}&edit=${post.id}`}
          >
            {t("card.edit")}
          </Link>
        )}
        {can.approve && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => act(() => posts_approve({ id: post.id }))}
          >
            {t("card.approve")}
          </button>
        )}
        {can.cancel && (
          <button
            type="button"
            className={destructiveButtonClass}
            disabled={busy}
            onClick={() =>
              window.confirm(t("card.confirmCancel")) &&
              act(() => posts_cancel({ id: post.id }))
            }
          >
            {t("common.cancel")}
          </button>
        )}
        {can.deletePublished && (
          <button
            type="button"
            className={destructiveButtonClass}
            disabled={busy}
            onClick={() =>
              window.confirm(t("card.confirmDelete")) &&
              act(
                () => posts_deletePublished({ id: post.id }),
                noPublished,
                t("card.deleting"),
              )
            }
          >
            {t("card.deletePublished")}
          </button>
        )}
        {can.cancel && can.deletePublished && (
          <span className="text-xs text-muted-foreground">
            {t("card.cancelHelp")}
          </span>
        )}
      </div>
      {can.reject && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-1 flex-col gap-1">
            {t("common.rejectReason")}
            <input
              className={field}
              value={reason}
              placeholder={t("common.rejectPlaceholder")}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy || reason.trim() === ""}
            onClick={() => act(() => posts_reject({ id: post.id, reason }))}
          >
            {t("card.reject")}
          </button>
        </div>
      )}
      {view.foot && <p className="text-xs text-muted-foreground">{view.foot}</p>}
      {note && (
        <p role="status" className="text-sm text-muted-foreground">
          {note}
        </p>
      )}
      <ErrorText message={error} />
    </article>
  );
}
