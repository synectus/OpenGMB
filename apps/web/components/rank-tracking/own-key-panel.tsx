"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  geogrid_byoKey_delete,
  geogrid_byoKey_set,
  geogrid_byoKey_verify,
} from "../../app/_generated/actions";
import { keyStatusLine } from "../../lib/tracker-setup";
import { useTimeFormat } from "../time-format-provider";
import { buttonClass, ErrorText, inputClass, secondaryButtonClass } from "../ui";

type Key = { configured: boolean; login: string | null; lastVerifiedAt: string | null };
type Result = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

export function OwnKeyPanel({ keyState }: { keyState: Key }) {
  const t = useTranslations("geogrid");
  const tc = useTranslations("geogridCost");
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const tf = useTimeFormat();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function call(fn: () => Promise<Result>) {
    setPending(true);
    setError(null);
    setNote(null);
    const r = await fn();
    setPending(false);
    if (!r.ok) {
      setError(`${r.error!.code}: ${r.error!.message}`);
      return null;
    }
    return r;
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!(await call(() => geogrid_byoKey_set({ login, password })))) return;
    setLogin("");
    setPassword("");
    router.refresh();
  }
  async function verify() {
    const r = await call(() => geogrid_byoKey_verify());
    if (!r) return;
    const d = r.data as { ok: boolean; message: string };
    setNote(d.ok ? { ok: true, text: t("key.verifiedOk") } : { ok: false, text: t("key.verifyFailed", { message: d.message }) });
    router.refresh();
  }
  async function remove() {
    if (!window.confirm(tc("key.confirmRemove"))) return;
    if (await call(() => geogrid_byoKey_delete())) router.refresh();
  }

  return (
    <section aria-label={t("key.panelLabel")} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-base font-bold text-foreground">{t("key.heading")}</h2>
      <p className="text-sm text-foreground">{keyStatusLine(keyState, tf, t, tc)}</p>
      <p className="text-xs text-muted-foreground">
        {tc("key.explain")}
      </p>
      <form aria-label={t("key.formLabel")} onSubmit={save} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {t("key.login")}
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" className={inputClass} />
        </label>
        <div className="flex flex-col gap-1 text-sm font-semibold">
          <label htmlFor="rt-api-password">{t("key.password")}</label>
          <div className="flex gap-2">
            <input
              id="rt-api-password"
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              className={`min-w-0 flex-1 ${inputClass}`}
            />
            <button
              type="button"
              aria-label={show ? t("key.hide") : t("key.show")}
              onClick={() => setShow((s) => !s)}
              className={secondaryButtonClass}
            >
              <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass} disabled={pending || !login || !password}>
            {keyState.configured ? t("key.replace") : t("key.save")}
          </button>
          <button type="button" className={secondaryButtonClass} disabled={pending || !keyState.configured} onClick={verify}>
            {t("key.verify")}
          </button>
          <button
            type="button"
            className={secondaryButtonClass.replace("text-foreground", "text-destructive")}
            disabled={pending || !keyState.configured}
            onClick={remove}
          >
            {t("key.remove")}
          </button>
        </div>
        <span className="text-xs text-muted-foreground">{t("key.removeNote")}</span>
      </form>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={`text-sm font-semibold ${note.ok ? "text-good" : "text-bad"}`}>
          {note.text}
        </p>
      )}
      <ErrorText message={error} />
    </section>
  );
}
