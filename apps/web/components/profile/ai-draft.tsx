"use client";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { guardrailLabel } from "../../lib/labels";
import { useAiNotice } from "../ai-notice";
import { runCall } from "../post-card";
import { hintClass } from "./section";
import { secondaryButtonClass } from "../ui";

type DraftData = {
  status: string;
  draft: string | null;
  blockedRuleIds: string[];
  warningRuleIds: string[];
  truncated: boolean;
  maxChars: number;
  keywordsConsidered?: string[];
  keywordsIncluded?: string[];
};

/**
 * "Draft with AI" beside a text field. It only fills the field (onFill); nothing is saved. What the person
 * sees afterwards is the normal Preview changes, Propose and approval. Search terms the draft includes are
 * a hint, never a requirement.
 */
export function AiDraftButton({
  call,
  hasText,
  onFill,
}: {
  call: () => ReturnType<Parameters<typeof runCall>[0]>;
  /** The field already holds text: ask before replacing it. */
  hasText: boolean;
  onFill: (text: string) => void;
}) {
  const t = useTranslations("profile");
  const notice = useAiNotice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ tone: "info" | "bad"; text: string }[]>([]);

  async function draft() {
    if (!(await notice.ready())) return;
    if (hasText && !window.confirm(t("editor.aiConfirmReplace"))) return;
    setBusy(true);
    setError(null);
    setNotes([{ tone: "info", text: t("editor.aiWorking") }]);
    const r = await runCall<DraftData>(call);
    setBusy(false);
    if ("error" in r) {
      setNotes([]);
      return setError(r.error);
    }
    const d = r.data;
    if (d.status !== "ok" || d.draft === null) {
      return setNotes([
        { tone: "bad", text: t("editor.aiBlocked", { rules: d.blockedRuleIds.map((id) => guardrailLabel(id)).join(", ") }) },
      ]);
    }
    onFill(d.draft);
    const out = [{ tone: "info" as const, text: t("editor.aiFilled") }];
    if (d.truncated) out.push({ tone: "info", text: t("editor.aiTrimmed", { limit: d.maxChars }) });
    if (d.warningRuleIds.length > 0) {
      out.push({ tone: "info", text: t("editor.aiWarn", { rules: d.warningRuleIds.map((id) => guardrailLabel(id)).join(", ") }) });
    }
    const asked = d.keywordsConsidered ?? [];
    if (asked.length > 0) {
      const used = d.keywordsIncluded ?? [];
      out.push({
        tone: "info",
        text:
          used.length > 0
            ? t("editor.keywordsIncluded", { list: used.join(", ") })
            : t("editor.keywordsNoneUsed", { list: asked.join(", ") }),
      });
    }
    setNotes(out);
  }

  return (
    <div className="flex flex-col gap-1">
      {notice.dialog}
      <button type="button" className={`${secondaryButtonClass} self-start`} disabled={busy} onClick={draft}>
        <Sparkles aria-hidden className="size-4" />
        {t("editor.draftWithAi")}
      </button>
      <div aria-live="polite" className="flex flex-col gap-0.5">
        {notes.map((n) => (
          <p key={n.text} className={n.tone === "bad" ? "text-xs font-semibold text-bad" : hintClass}>
            {n.text}
          </p>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
