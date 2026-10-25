"use client";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { zonedWallToUtc } from "@opengmb/core/time";
import { failureLabel } from "../lib/failure-labels";
import {
  categoryChip,
  fileProblemParts,
  fileSize,
  patchItem,
  queueItem,
  resultsSettled,
  sendable,
  type Limits,
  type LocationResult,
  type QueueItem,
} from "../lib/photos";
import { buttonClass, secondaryButtonClass } from "./ui";

export type UploadLimits = Limits;

const TONE: Record<QueueItem["phase"], string> = {
  ready: "text-muted-foreground",
  uploading: "text-info",
  queued: "text-info",
  scheduled: "text-info",
  applied: "text-good",
  failed: "text-bad",
};

async function shortEdgeOf(file: File): Promise<number | null> {
  try {
    const bmp = await createImageBitmap(file);
    const short = Math.min(bmp.width, bmp.height);
    bmp.close();
    return short;
  } catch {
    return null; // not decodable here; core reads the header and decides
  }
}

type WireResult = {
  locationId: string;
  operation: { status: LocationResult["status"]; error: string | null } | null;
  error: string | null;
};
type Sent = { status: number; body: { ok?: boolean; operation?: { id: string }; batchId?: string; results?: WireResult[]; error?: { code?: string; message?: string } } | null };
/** A location skipped before it was queued (no access, not linked ...) reads as failed with its code. */
const toResult = (r: WireResult): LocationResult =>
  r.operation
    ? { locationId: r.locationId, status: r.operation.status, error: r.operation.error }
    : { locationId: r.locationId, status: "failed", error: r.error ?? "INTERNAL" };

/** multipart POST with upload progress (fetch cannot report it). Returns the xhr so it can be aborted. */
function send(form: FormData, onProgress: (p: number) => void) {
  const xhr = new XMLHttpRequest();
  const done = new Promise<Sent | "aborted">((resolve, reject) => {
    xhr.open("POST", "/api/media/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => resolve("aborted");
    xhr.onload = () => {
      let body: Sent["body"] = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // a proxy error page, not JSON
      }
      resolve({ status: xhr.status, body });
    };
    xhr.send(form);
  });
  return { xhr, done };
}

const pick = `${secondaryButtonClass} flex-1 cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring`;

export function PhotoUpload({
  locationId,
  categories,
  limits,
  settle,
  onDone,
  siblings,
  timeZone,
  pollBatch,
}: {
  locationId: string;
  /** The client's other locations the same photo can go to. */
  siblings: { id: string; name: string }[];
  /** The client's time zone: the "send at" time is a wall time in it. */
  timeZone: string;
  /** Per-location results of a batch, from media.batch; null when the call failed. */
  pollBatch: (batchId: string) => Promise<LocationResult[] | null>;
  categories: readonly string[];
  limits: UploadLimits;
  /** Polls the queued operation; null = applied, otherwise a `CODE: label` line. */
  settle: (opId: string) => Promise<string | null>;
  onDone: () => void;
}) {
  const t = useTranslations("locationHub.upload");
  const tm = useTranslations("locationHub.media");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const running = useRef<XMLHttpRequest | null>(null);
  const seq = useRef(0);
  /** The File objects, by queue key (state holds only plain facts). */
  const files = useRef(new Map<string, File>());
  const [extra, setExtra] = useState<string[]>([]);
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [sendAtError, setSendAtError] = useState<string | null>(null);
  const names = new Map(siblings.map((l) => [l.id, l.name]));
  const scheduledIso = later && sendAt ? (zonedWallToUtc(sendAt, timeZone)?.toISOString() ?? null) : null;
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList | null) {
    if (!list) return;
    const added: QueueItem[] = [];
    for (const f of Array.from(list)) {
      const item = queueItem(`f${seq.current++}`, f, await shortEdgeOf(f));
      files.current.set(item.key, f);
      added.push(item);
    }
    setQueue((q) => [...q.filter((i) => i.phase !== "applied"), ...added]);
    if (cameraRef.current) cameraRef.current.value = "";
    if (libraryRef.current) libraryRef.current.value = "";
  }

  async function uploadOne(item: QueueItem) {
    const file = files.current.get(item.key);
    if (!file) return;
    const set = (p: Partial<QueueItem>) => setQueue((q) => patchItem(q, item.key, p));
    set({ phase: "uploading", percent: 0, error: null });
    const form = new FormData();
    for (const id of [locationId, ...extra]) form.append("locationId", id);
    if (later && scheduledIso) form.set("scheduledFor", scheduledIso);
    form.set("category", item.category);
    form.set("file", file);
    try {
      const { xhr, done } = send(form, (percent) => set({ percent }));
      running.current = xhr;
      const r = await done;
      running.current = null;
      if (r === "aborted") return set({ phase: "ready", percent: 0 });
      if (r.status === 202 && r.body?.ok && r.body.results && r.body.batchId) {
        let results = r.body.results.map(toResult);
        if (later) return set({ phase: "scheduled", results });
        set({ phase: "queued", results });
        for (let n = 0; n < 40 && !resultsSettled(results); n++) {
          await new Promise((res) => setTimeout(res, 1500));
          results = (await pollBatch(r.body.batchId)) ?? results;
          set({ results });
        }
        const bad = results.filter((x) => x.status === "failed").length;
        return set(
          bad > 0
            ? { phase: "failed", results, error: t("someFailed", { bad, total: results.length }) }
            : { phase: "applied", results },
        );
      }
      if (r.status !== 202 || !r.body?.ok || !r.body.operation) {
        const code = r.body?.error?.code ?? (r.status === 401 || r.status === 403 ? "UNAUTHENTICATED" : `HTTP_${r.status}`);
        const message = r.body?.error?.message ?? t("signIn");
        return set({ phase: "failed", error: `${code}: ${message}` });
      }
      set({ phase: "queued" });
      const problem = await settle(r.body.operation.id);
      set(problem ? { phase: "failed", error: problem } : { phase: "applied" });
    } catch {
      running.current = null;
      set({ phase: "failed", error: t("network") });
    }
  }

  async function uploadAll(items: QueueItem[]) {
    if (later && (!scheduledIso || new Date(scheduledIso).getTime() < Date.now())) {
      return setSendAtError(t("sendAtInvalid"));
    }
    setBusy(true);
    for (const item of items) await uploadOne(item);
    setBusy(false);
    onDone();
  }

  const catLabel = (c: string) => (tm.has(`cat.${c}`) ? tm(`cat.${c}`) : categoryChip(c));
  const problemText = (i: QueueItem) => {
    const p = fileProblemParts(i, i.category, limits, i.shortEdge);
    return p ? t(`problem.${p.key}`, p.values) : null;
  };
  const statusText = (i: QueueItem): string => {
    switch (i.phase) {
      case "uploading":
        return `${i.percent}%`;
      case "queued":
        return t("queued");
      case "scheduled":
        return t("scheduled", { at: sendAt.replace("T", " ") });
      case "applied":
        return t("applied");
      case "failed":
        return t("failed", { error: i.error ?? "INTERNAL: request failed" });
      default:
        return problemText(i) ?? t("ready");
    }
  };
  const resultText = (x: LocationResult) => {
    const label = x.status === "failed" ? failureLabel(x.error ?? "failed") : t(`result.${x.status}`);
    return `${names.get(x.locationId) ?? tm("thisLocation")}: ${label}`;
  };
  const toSend = sendable(queue, limits);
  const skipped = queue.filter((i) => i.phase === "ready" && problemText(i) !== null).length;
  const note = skipped === 0 ? null : skipped === 1 ? t("skippedOne") : t("skipped", { count: skipped });
  const uploading = queue.some((i) => i.phase === "uploading");

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!busy) void addFiles(e.dataTransfer.files);
        }}
        className={`flex min-h-24 items-center justify-center rounded-control border border-dashed px-4 text-center text-sm text-muted-foreground ${
          over ? "border-brand bg-brand-tint" : "border-input bg-muted"
        }`}
      >
        {t("drop")}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className={pick}>
          {t("take")}
          <input
            ref={cameraRef}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            className="sr-only"
            disabled={busy}
            onChange={(e) => void addFiles(e.target.files)}
          />
        </label>
        <label className={pick}>
          {t("library")}
          <input
            ref={libraryRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            className="sr-only"
            disabled={busy}
            onChange={(e) => void addFiles(e.target.files)}
          />
        </label>
      </div>

      {queue.length > 0 && (
        <ul aria-label={t("queueAria")} className="flex flex-col divide-y divide-border rounded-control border border-border">
          {queue.map((i) => (
            <li key={i.key} className="flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <strong className="min-w-0 break-all text-sm">{i.name}</strong>
                <span className="text-xs tabular-nums text-muted-foreground">{fileSize(i.size)}</span>
              </div>
              <label className="flex items-center gap-2 text-xs font-medium">
                {t("category")}
                <select
                  value={i.category}
                  disabled={i.phase !== "ready" && i.phase !== "failed"}
                  onChange={(e) => setQueue((q) => patchItem(q, i.key, { category: e.target.value }))}
                  className="min-h-8 rounded-md border border-input bg-card px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {catLabel(c)}
                    </option>
                  ))}
                </select>
              </label>
              {i.phase === "uploading" && (
                <div className="flex items-center gap-2">
                  <progress value={i.percent} max={100} aria-label={t("progressAria")} className="h-2 flex-1 accent-primary" />
                  <span className="text-xs tabular-nums">{i.percent}%</span>
                </div>
              )}
              <span role={i.phase === "failed" ? "alert" : undefined} className={`text-xs ${TONE[i.phase]}`}>
                {i.phase === "uploading" ? null : statusText(i)}
              </span>
              {i.results && (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {i.results.map((x) => (
                    <li key={x.locationId} className={x.status === "failed" ? "text-bad" : x.status === "applied" ? "text-good" : "text-info"}>
                      {resultText(x)}
                    </li>
                  ))}
                </ul>
              )}
              {i.phase === "failed" && (
                <button type="button" className={`${secondaryButtonClass} self-start`} disabled={busy} onClick={() => void uploadAll([i])}>
                  {t("tryAgain")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {siblings.length > 0 && (
        <fieldset className="flex flex-col gap-1.5 rounded-control border border-border px-3 py-2" disabled={busy}>
          <legend className="px-1 text-xs font-medium">{t("alsoSend")}</legend>
          {siblings.map((l) => (
            <label key={l.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={extra.includes(l.id)}
                onChange={(e) => setExtra((x) => (e.target.checked ? [...x, l.id] : x.filter((v) => v !== l.id)))}
              />
              {l.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={later} disabled={busy} onChange={(e) => setLater(e.target.checked)} />
          {t("sendLater")}
        </label>
        {later && (
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t("sendAt", { zone: timeZone })}
            <input
              type="datetime-local"
              value={sendAt}
              disabled={busy}
              onChange={(e) => {
                setSendAt(e.target.value);
                setSendAtError(null);
              }}
              className="min-h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
        )}
        {sendAtError && (
          <span role="alert" className="text-xs text-bad">
            {sendAtError}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t("help", { min: fileSize(limits.minBytes), max: fileSize(limits.maxBytes), edge: limits.minShortEdgePx })}</p>
      <div className="flex flex-wrap items-center gap-2">
        {uploading ? (
          <button type="button" className={secondaryButtonClass} onClick={() => running.current?.abort()}>
            {t("cancel")}
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass}
            disabled={busy || toSend.length === 0}
            onClick={() => void uploadAll(toSend)}
          >
            {busy ? t("sending") : t("button", { count: Math.max(1, toSend.length) })}
          </button>
        )}
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  );
}
