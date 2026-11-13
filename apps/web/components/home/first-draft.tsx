"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { onboarding_firstDraft } from "../../app/_generated/actions";
import { useAiNotice } from "../ai-notice";
import { buttonClass, ErrorText, secondaryButtonClass } from "../ui";

export type FirstDraftState = { used: boolean; reviewId: string | null; replyStatus: string | null; aiReady: boolean };

const panel = "flex flex-col gap-2 rounded-panel border border-border bg-card p-(--panel-p) shadow-card";

/**
 * ON2: one free reply draft, written only when the person presses the button. The review text goes to the AI provider
 * at that click and not before. The draft is saved as a draft: nothing goes to Google until they submit it.
 */
export function FirstDraft({
  state,
  canDraft,
  hasLocations,
  reviewHref,
  rankHref,
}: {
  state: FirstDraftState;
  canDraft: boolean;
  hasLocations: boolean;
  /** Link to the review the draft is for (or would be for). */
  reviewHref: string;
  rankHref: string;
}) {
  const t = useTranslations("home.firstDraft");
  const router = useRouter();
  const ai = useAiNotice();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    if (!(await ai.ready())) return;
    setPending(true);
    const r = await onboarding_firstDraft({});
    if (!r.ok) {
      setPending(false);
      return setError(r.error.message);
    }
    router.refresh();
  }

  // A review the person cannot see comes back without an id: no link, no card.
  if (state.used && state.reviewId && state.replyStatus === "draft") {
    return (
      <section aria-labelledby="first-draft-h" className={panel}>
        <h2 id="first-draft-h" className="font-display text-base font-bold text-foreground">{t("readyTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("readyText")}</p>
        <Link href={reviewHref} className={`${secondaryButtonClass} self-start`}>{t("readyLink")}</Link>
      </section>
    );
  }
  if (state.used && state.reviewId && state.replyStatus === null) {
    return (
      <section aria-labelledby="first-draft-h" className={panel}>
        <h2 id="first-draft-h" className="font-display text-base font-bold text-foreground">{t("blockedTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("blockedText")}</p>
        <Link href={reviewHref} className={`${secondaryButtonClass} self-start`}>{t("blockedLink")}</Link>
      </section>
    );
  }
  if (!state.used && state.reviewId && state.aiReady && canDraft) {
    return (
      <section aria-labelledby="first-draft-h" className={panel}>
        <h2 id="first-draft-h" className="font-display text-base font-bold text-foreground">{t("offerTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("offerText")}</p>
        <button type="button" onClick={() => void onClick()} disabled={pending} className={`${buttonClass} self-start`}>
          {pending ? t("working") : t("offerButton")}
        </button>
        <ErrorText message={error} />
        {ai.dialog}
      </section>
    );
  }
  if (!state.used && !state.reviewId && hasLocations && canDraft) {
    return (
      <section aria-labelledby="first-draft-h" className={panel}>
        <h2 id="first-draft-h" className="font-display text-base font-bold text-foreground">{t("noneTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("noneText")}</p>
        <Link href={rankHref} className={`${secondaryButtonClass} self-start`}>{t("noneLink")}</Link>
      </section>
    );
  }
  return null;
}
