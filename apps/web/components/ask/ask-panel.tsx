"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { askSynGMB } from "../../lib/assistant-actions";
import { agentsHref } from "../../lib/agents";
import { ErrorText, buttonClass, inputClass, secondaryButtonClass } from "../ui";

type Turn = {
  role: "user" | "assistant";
  text: string;
  tools?: { name: string; ok: boolean }[];
  proposals?: number;
  note?: string;
};
const MAX_USER_MESSAGES = 20; // mirrors ASSISTANT.maxUserMessages in core; the server enforces it
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** The "Ask SynGMB" button and side panel. The conversation lives here, in the browser, and is sent whole. */
export function AskPanel({ client }: { client: { id: string; name: string } | null }) {
  const t = useTranslations("assistant");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? "ask-panel" : undefined}
        onClick={() => setOpen(!open)}
        className={`inline-flex min-h-10 items-center gap-1.5 rounded-control border border-input bg-card px-3 text-sm font-semibold hover:bg-muted ${focus}`}
      >
        <Sparkles aria-hidden className="size-4 text-brand" />
        <span className="hidden sm:inline">{t("open")}</span>
        <span className="sr-only sm:hidden">{t("open")}</span>
      </button>
      {/* Keyed by client: switching client starts a fresh chat. Mounted while closed so the chat is kept. */}
      <AskBody key={client?.id ?? "none"} client={client} open={open} onClose={close} />
    </>
  );
}

function AskBody({
  client,
  open,
  onClose,
}: {
  client: { id: string; name: string } | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("assistant");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [turns, pending]);

  const userCount = turns.filter((x) => x.role === "user").length;
  const full = userCount >= MAX_USER_MESSAGES;

  function send() {
    const message = text.trim();
    if (!client || !message || pending || full) return;
    const next: Turn[] = [...turns, { role: "user", text: message }];
    setTurns(next);
    setText("");
    setError(null);
    start(async () => {
      const r = await askSynGMB(client.id, next.map(({ role, text: x }) => ({ role, text: x })));
      if (!r.ok) return setError(t("status.error"));
      const d = r.data;
      const key = d.status === "budget" ? `limit_${d.budgetScope ?? "platform"}` : d.status;
      setTurns([
        ...next,
        {
          role: "assistant",
          // A refusal or limit has no model text; show the plain reason instead.
          text: d.reply || (d.status === "ok" ? "" : t(`status.${key}`)),
          tools: d.tools,
          proposals: d.proposals.length,
          note: d.reply && d.status !== "ok" ? t(`status.${key}`) : undefined,
        },
      ]);
    });
  }

  // Not rendered while closed (no dialog in the DOM); this component stays mounted, so the chat is kept.
  if (!open) return null;
  return (
    <section
      id="ask-panel"
      role="dialog"
      aria-label={t("title")}
      className="fixed bottom-0 right-0 top-(--shell-top) z-40 flex w-full flex-col border-l border-border bg-card shadow-card sm:w-96"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-display text-base font-extrabold">{t("title")}</h2>
        <div className="flex items-center gap-1">
          {turns.length > 0 && (
            <button type="button" className={`${secondaryButtonClass} min-h-9 px-3`} onClick={() => setTurns([])}>
              {t("newChat")}
            </button>
          )}
          <button
            type="button"
            aria-label={t("close")}
            onClick={onClose}
            className={`inline-flex size-9 items-center justify-center rounded-control hover:bg-muted ${focus}`}
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      <div ref={log} aria-live="polite" className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-sm">
        {!client ? (
          <p className="text-muted-foreground">{t("pickClient")}</p>
        ) : (
          turns.length === 0 && <p className="text-muted-foreground">{t("intro", { client: client.name })}</p>
        )}
        {turns.map((x, i) => (
          <div
            key={i}
            className={`flex flex-col gap-1.5 rounded-control px-3 py-2 ${
              x.role === "user" ? "self-end bg-brand-tint text-brand-text" : "self-start bg-muted"
            }`}
          >
            <span className="text-xs font-bold text-muted-foreground">{x.role === "user" ? t("you") : t("assistant")}</span>
            {x.text && <p className="whitespace-pre-wrap">{x.text}</p>}
            {x.note && <p className="text-xs text-muted-foreground">{x.note}</p>}
            {x.tools && x.tools.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("toolsRan")}:{" "}
                {x.tools.map((tool, j) => (
                  <code key={j} className="mr-1 rounded bg-card px-1">
                    {tool.name}
                    {tool.ok ? "" : ` (${t("toolFailed")})`}
                  </code>
                ))}
              </p>
            )}
            {x.proposals ? (
              <div className="flex flex-col gap-1 border-t border-border pt-2">
                <span className="font-semibold">{t("proposalsWaiting", { count: x.proposals })}</span>
                <Link href={agentsHref({ view: "proposals" })} className={`${buttonClass} min-h-9 self-start`}>
                  {t("confirmThem")}
                </Link>
                <span className="text-xs text-muted-foreground">{t("expires")}</span>
              </div>
            ) : null}
          </div>
        ))}
        {pending && <p className="text-muted-foreground">{t("thinking")}</p>}
        <ErrorText message={error} />
      </div>
      <form
        className="flex flex-col gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {full && <p className="text-xs text-muted-foreground">{t("tooLong")}</p>}
        <textarea
          ref={input}
          aria-label={t("title")}
          className={`${inputClass} min-h-20 resize-none`}
          placeholder={t("placeholder")}
          value={text}
          maxLength={2000}
          disabled={!client || full}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" className={buttonClass} disabled={!client || pending || full || !text.trim()}>
          {t("send")}
        </button>
      </form>
    </section>
  );
}
