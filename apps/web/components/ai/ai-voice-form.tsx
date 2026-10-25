"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { aiVoice_update } from "../../app/_generated/actions";
import { buttonClass, ErrorText, inputClass } from "../ui";

export type VoiceValues = { tone: string; bannedWords: string[]; signOff: string; language: string };

const parseWords = (text: string) => [...new Set(text.split("\n").map((w) => w.trim()).filter(Boolean))];

/** Brand voice for AI drafts: tone, words to avoid, sign-off and language of one client. */
export function AiVoiceForm({
  workspaceId,
  workspaceName,
  initial,
  canEdit,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: VoiceValues;
  canEdit: boolean;
}) {
  const t = useTranslations("aiVoice");
  const router = useRouter();
  const [tone, setTone] = useState(initial.tone);
  const [words, setWords] = useState(initial.bannedWords.join("\n"));
  const [signOff, setSignOff] = useState(initial.signOff);
  const [language, setLanguage] = useState(initial.language);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    setSaved(false);
    set(v);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const list = parseWords(words);
    if (list.length > 50) return setError(t("tooMany"));
    setPending(true);
    setError(null);
    const r = await aiVoice_update({ workspaceId, tone, bannedWords: list, signOff, language });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2.5 rounded-panel border border-border bg-card p-(--panel-p) shadow-card">
      <h2 className="font-display text-lg font-bold">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">{t("intro", { name: workspaceName })}</p>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("tone")}
        <input className={inputClass} value={tone} maxLength={200} placeholder={t("tonePlaceholder")} disabled={!canEdit || pending} onChange={(e) => touch(setTone)(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("bannedWords")}
        <textarea className={inputClass} rows={3} value={words} disabled={!canEdit || pending} onChange={(e) => touch(setWords)(e.target.value)} />
        <span className="text-xs font-normal text-muted-foreground">{t("bannedWordsHint")}</span>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("signOff")}
        <input className={inputClass} value={signOff} maxLength={200} placeholder={t("signOffPlaceholder")} disabled={!canEdit || pending} onChange={(e) => touch(setSignOff)(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("language")}
        <input className={inputClass} value={language} maxLength={40} disabled={!canEdit || pending} onChange={(e) => touch(setLanguage)(e.target.value)} />
        <span className="text-xs font-normal text-muted-foreground">{t("languageHint")}</span>
      </label>
      <ErrorText message={error} />
      {canEdit ? (
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={pending}>
            {pending ? t("saving") : t("save")}
          </button>
          {saved && <span className="text-sm text-good" role="status">{t("saved")}</span>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("notAllowed")}</p>
      )}
    </form>
  );
}
