"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  postTemplates_create, postTemplates_delete, postTemplates_update, posts_check, workspaces_setPostLanguage,
} from "../../app/_generated/actions";
import { ctaFullName } from "../../lib/posts-lists";
import { languageLabel, templateCheckPayload, templateMeta, type Language, type TemplateView } from "../../lib/post-templates";
import { runCall } from "../post-card";
import { Violations, type GuardrailResult } from "../reply-panel";
import { buttonClass, destructiveButtonClass, EmptyState, ErrorText, inputClass, secondaryButtonClass } from "../ui";
import { useTimeFormat } from "../time-format-provider";
import { PostImageField } from "./post-image-field";

const MAX_CHARS = 1500;
const CTAS = ["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"] as const;
const TYPES = ["STANDARD", "EVENT", "OFFER"] as const;

type Draft = {
  id: string | null;
  name: string;
  topicType: TemplateView["topicType"];
  language: string;
  summary: string;
  ctaType: string;
  ctaUrl: string;
  eventTitle: string;
  couponCode: string;
  redeemOnlineUrl: string;
  termsConditions: string;
  imageUrl: string;
  imageId: string | null;
};

const blank = (language: string): Draft => ({
  id: null, name: "", topicType: "STANDARD", language, summary: "", ctaType: "none", ctaUrl: "",
  eventTitle: "", couponCode: "", redeemOnlineUrl: "", termsConditions: "", imageUrl: "", imageId: null,
});
const fromTemplate = (t: TemplateView): Draft => ({
  id: t.id, name: t.name, topicType: t.topicType, language: t.language, summary: t.summary,
  ctaType: t.cta?.actionType ?? "none", ctaUrl: t.cta?.url ?? "", eventTitle: t.eventTitle ?? "",
  couponCode: t.offer?.couponCode ?? "", redeemOnlineUrl: t.offer?.redeemOnlineUrl ?? "",
  termsConditions: t.offer?.termsConditions ?? "", imageUrl: t.image?.url ?? "", imageId: t.image?.id ?? null,
});
const opt = (v: string) => (v.trim() ? v.trim() : undefined);
const toInput = (d: Draft) => ({
  name: d.name.trim(),
  topicType: d.topicType,
  language: d.language,
  summary: d.summary,
  cta: d.ctaType === "none" ? null : { actionType: d.ctaType, ...(d.ctaType === "CALL" ? {} : { url: opt(d.ctaUrl) }) },
  eventTitle: d.topicType === "STANDARD" ? null : opt(d.eventTitle),
  offer: d.topicType === "OFFER" ? { couponCode: opt(d.couponCode), redeemOnlineUrl: opt(d.redeemOnlineUrl), termsConditions: opt(d.termsConditions) } : null,
  imageId: d.imageId,
});

export function TemplatesView({
  workspaceId, workspaceName, templates, canManage, languages, defaultLanguage, canConfigure, maxBytes,
}: {
  workspaceId: string;
  workspaceName: string;
  templates: TemplateView[];
  canManage: boolean;
  languages: Language[];
  defaultLanguage: string;
  canConfigure: boolean;
  maxBytes: number;
}) {
  const router = useRouter();
  const tp = useTranslations("posts");
  const tf = useTimeFormat();
  const [draft, setDraft] = useState<Draft>(() => (templates[0] ? fromTemplate(templates[0]) : blank(defaultLanguage)));
  const [defLang, setDefLang] = useState(defaultLanguage);
  const [checked, setChecked] = useState<GuardrailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const current = templates.find((t) => t.id === draft.id) ?? null;
  const count = Array.from(draft.summary).length;

  // Live check of the template content (debounced), like Compose.
  const key = JSON.stringify(templateCheckPayload({
    id: "", workspaceId, name: draft.name || tp("tpl.defaultName"), topicType: draft.topicType, language: draft.language,
    summary: draft.summary, cta: toInput(draft).cta, eventTitle: opt(draft.eventTitle) ?? null,
    offer: toInput(draft).offer, image: draft.imageUrl ? { id: draft.imageId ?? "", name: "", url: draft.imageUrl } : null,
    updatedAt: "", updatedByName: "",
  }));
  useEffect(() => {
    let stale = false;
    const t = setTimeout(async () => {
      const r = await runCall<GuardrailResult>(() => posts_check(JSON.parse(key)));
      if (stale) return;
      if ("error" in r) setError(r.error);
      else setChecked(r.data);
    }, 500);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [key]);

  async function save() {
    setNote(null);
    const input = toInput(draft);
    const r = draft.id
      ? await runCall<{ template: TemplateView }>(() => postTemplates_update({ id: draft.id, ...input }))
      : await runCall<{ template: TemplateView }>(() => postTemplates_create({ workspaceId, ...input }));
    if ("error" in r) return setError(r.error);
    setError(null);
    setNote(tp("tpl.saved"));
    setDraft(fromTemplate(r.data.template));
    router.refresh();
  }
  async function remove() {
    if (!draft.id || !window.confirm(tp("tpl.confirmDelete"))) return;
    const r = await runCall(() => postTemplates_delete({ id: draft.id }));
    if ("error" in r) return setError(r.error);
    setError(null);
    setDraft(blank(defLang));
    router.refresh();
  }
  async function saveDefault() {
    const r = await runCall(() => workspaces_setPostLanguage({ workspaceId, language: defLang }));
    if ("error" in r) return setError(r.error);
    setError(null);
    setNote(tp("tpl.defaultSaved"));
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-start gap-5">
      <section aria-label={tp("tpl.section")} className="flex min-w-72 flex-[1_1_320px] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold">{tp("tpl.section")}</h2>
          <span className="text-sm text-muted-foreground">{tp("tpl.sharedBy", { name: workspaceName })}</span>
          {canManage && (
            <button type="button" className={`${buttonClass} ml-auto`} onClick={() => { setDraft(blank(defLang)); setNote(null); }}>
              {tp("tpl.new")}
            </button>
          )}
        </div>
        {templates.length === 0 ? (
          <EmptyState title={tp("tpl.noneTitle")}>{tp("tpl.noneBody")}</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
            {templates.map((t) => (
              <li key={t.id} className={t.id === draft.id ? "bg-muted" : ""}>
                <button type="button" className="flex w-full flex-col gap-0.5 p-3 text-left" onClick={() => { setDraft(fromTemplate(t)); setNote(null); }}>
                  <span className="flex items-center gap-2">
                    <strong className="font-semibold text-primary">{t.name}</strong>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{tp(`tpl.type.${t.topicType}`)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{templateMeta(tp, t, languages)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <section aria-label={tp("tpl.languageSection")} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
          <h2 className="text-lg font-bold">{tp("tpl.languageSection")}</h2>
          <p className="text-sm text-muted-foreground">{tp("tpl.languageBody")}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {tp("tpl.defaultFor", { name: workspaceName })}
              <select className={inputClass} value={defLang} disabled={!canConfigure} onChange={(e) => setDefLang(e.target.value)}>
                {languages.map((l) => <option key={l.code} value={l.code}>{languageLabel(languages, l.code)}</option>)}
              </select>
            </label>
            {canConfigure && (
              <button type="button" className={secondaryButtonClass} onClick={saveDefault} disabled={defLang === defaultLanguage}>{tp("tpl.saveDefault")}</button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{tp("tpl.twoLanguages")}</p>
        </section>
      </section>

      <form aria-label={tp("tpl.editForm")} className="flex min-w-0 flex-[999_1_480px] flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-card"
        onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-bold">{draft.id ? tp("tpl.editForm") : tp("tpl.new")}</h2>
          {current && <span className="text-sm text-muted-foreground">{tp("tpl.lastEdited", { name: current.updatedByName, date: tf.date(current.updatedAt, workspaceId) })}</span>}
        </div>
        <fieldset disabled={!canManage} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium">{tp("tpl.name")}
              <input className={inputClass} value={draft.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">{tp("common.postType")}
              <select className={inputClass} value={draft.topicType} onChange={(e) => set("topicType", e.target.value as Draft["topicType"])}>
                {TYPES.map((v) => <option key={v} value={v}>{tp(`tpl.type.${v}`)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">{tp("tpl.language")}
              <select className={inputClass} value={draft.language} onChange={(e) => set("language", e.target.value)}>
                {languages.map((l) => <option key={l.code} value={l.code}>{languageLabel(languages, l.code)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">{tp("common.callToAction")}
              <select className={inputClass} value={draft.ctaType} onChange={(e) => set("ctaType", e.target.value)}>
                <option value="none">{tp("cta.none")}</option>
                {CTAS.map((c) => <option key={c} value={c}>{ctaFullName(tp, c)}</option>)}
              </select>
            </label>
          </div>
          {draft.ctaType !== "none" && draft.ctaType !== "CALL" && (
            <label className="flex flex-col gap-1 text-sm font-medium">{tp("common.buttonUrl")}
              <input type="url" className={inputClass} value={draft.ctaUrl} onChange={(e) => set("ctaUrl", e.target.value)} />
            </label>
          )}
          {draft.topicType !== "STANDARD" && (
            <label className="flex flex-col gap-1 text-sm font-medium">{tp("tpl.eventTitle")}
              <input className={inputClass} value={draft.eventTitle} onChange={(e) => set("eventTitle", e.target.value)} />
            </label>
          )}
          {draft.topicType === "OFFER" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-medium">{tp("common.couponCode")}
                <input className={inputClass} value={draft.couponCode} onChange={(e) => set("couponCode", e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">{tp("common.redeemUrl")}
                <input type="url" className={inputClass} value={draft.redeemOnlineUrl} onChange={(e) => set("redeemOnlineUrl", e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium sm:col-span-2">{tp("common.terms")}
                <textarea rows={2} className={inputClass} value={draft.termsConditions} onChange={(e) => set("termsConditions", e.target.value)} />
              </label>
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm font-medium" lang={draft.language}>
            <span lang="en">{tp("common.postText")}</span>
            <textarea rows={5} className={inputClass} lang={draft.language} value={draft.summary} onChange={(e) => set("summary", e.target.value)} />
          </label>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{tp("tpl.checkNote")}</span>
            <span className={count > MAX_CHARS ? "font-semibold text-bad" : ""}>{count} / {MAX_CHARS}</span>
          </div>
          <PostImageField workspaceId={workspaceId} value={draft.imageUrl} maxBytes={maxBytes} libraryOnly disabled={!canManage}
            onChange={(url, id) => setDraft((d) => ({ ...d, imageUrl: url, imageId: id }))} />
        </fieldset>
        <section role="region" aria-label={tp("tpl.checkRegion")} className="rounded-control border border-border p-3 text-sm">
          {checked && checked.violations.length > 0 ? <Violations result={checked} /> : tp("tpl.noViolations")}
        </section>
        <ErrorText message={error} />
        {note && <p role="status" className="text-sm text-good">{note}</p>}
        <div className="flex flex-wrap gap-2">
          {canManage && <button type="submit" className={buttonClass} disabled={!draft.name.trim()}>{tp("tpl.save")}</button>}
          {draft.id && (
            <Link href={`/posts?view=compose&ws=${workspaceId}&template=${draft.id}`} className={secondaryButtonClass}>{tp("common.useInNewPost")}</Link>
          )}
          {canManage && draft.id && <button type="button" className={destructiveButtonClass} onClick={remove}>{tp("tpl.deleteBtn")}</button>}
        </div>
        <p className="text-xs text-muted-foreground">{tp("tpl.holdsNoLocations")}</p>
      </form>
    </div>
  );
}
