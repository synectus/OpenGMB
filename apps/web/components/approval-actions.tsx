"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import {
  posts_approve,
  posts_approveEdit,
  posts_cancel,
  posts_cancelEdit,
  posts_reject,
  posts_rejectEdit,
  profile_approve,
  profile_cancel,
  profile_reject,
  reviewReplies_approve,
  reviewReplies_reject,
} from "../app/_generated/actions";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./primitives/dialog";
import { buttonClass, destructiveButtonClass, ErrorText, secondaryButtonClass } from "./ui";

export type ApprovalType = "reply" | "post" | "changeset" | "postedit";

export function decide(type: ApprovalType, kind: "approve" | "reject", id: string, reason: string) {
  if (type === "reply") {
    return kind === "approve" ? reviewReplies_approve({ id }) : reviewReplies_reject({ id, reason });
  }
  if (type === "post") {
    return kind === "approve" ? posts_approve({ id }) : posts_reject({ id, reason });
  }
  if (type === "postedit") {
    return kind === "approve" ? posts_approveEdit({ id }) : posts_rejectEdit({ id, reason });
  }
  return kind === "approve" ? profile_approve({ id }) : profile_reject({ id, reason });
}

export type DiscardType = Exclude<ApprovalType, "reply">;

/** Cancels the item for good with the action that already does it. Replies have none: they are only sent back. */
export function discard(type: DiscardType, id: string) {
  if (type === "post") return posts_cancel({ id });
  if (type === "postedit") return posts_cancelEdit({ id });
  return profile_cancel({ id });
}

/**
 * Approve / send back with an always-visible reason (the Approvals page, whose S key focuses it).
 * Send back stays clickable: with no reason it focuses the box and says why, instead of looking dead.
 * Discard (only when `canDiscard`, which is core's per-item flag) asks first and has no shortcut.
 * Whether Approve shows is core's can.* flag; core enforces it again on click. The portal uses
 * PortalDecision instead.
 */
export function ApprovalActions({
  type,
  id,
  redirectTo,
  canDiscard = false,
}: {
  type: ApprovalType;
  id: string;
  redirectTo: string;
  canDiscard?: boolean;
}) {
  const t = useTranslations("approvals.actions");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  async function act(kind: "approve" | "reject") {
    if (kind === "reject" && reason.trim() === "") {
      setMissing(true);
      reasonRef.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    const result = await decide(type, kind, id, reason.trim());
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    router.push(redirectTo);
    router.refresh();
  }

  async function confirmDiscard() {
    if (type === "reply") return;
    setPending(true);
    setError(null);
    const result = await discard(type, id);
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    setConfirming(false);
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <ErrorText message={confirming ? null : error} />
      <div className="flex flex-wrap items-end gap-2.5">
        <button
          type="button"
          data-approval-action="approve"
          className={buttonClass}
          disabled={pending}
          onClick={() => act("approve")}
        >
          {t("approve")}
        </button>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs font-semibold">
          {t("reasonLabel")}
          <input
            ref={reasonRef}
            type="text"
            data-approval-reason
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (e.target.value.trim() !== "") setMissing(false);
            }}
            maxLength={2000}
            placeholder={t("reasonPlaceholder")}
            aria-describedby={hintId}
            aria-invalid={missing || undefined}
            className="min-h-(--control-h) rounded-lg border border-input bg-card px-3 text-sm font-normal text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-bad"
          />
        </label>
        <button
          type="button"
          data-approval-action="send-back"
          className={secondaryButtonClass}
          disabled={pending}
          onClick={() => act("reject")}
        >
          {t("sendBack")}
        </button>
      </div>
      <p
        id={hintId}
        role={missing ? "alert" : undefined}
        className={`text-xs ${missing ? "font-semibold text-bad" : "text-muted-foreground"}`}
      >
        {missing ? t("reasonMissing") : t("reasonHint")}
      </p>
      {canDiscard && type !== "reply" && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2.5 border-t border-border pt-3">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("discardNote")}</p>
          <button
            type="button"
            data-approval-action="discard"
            className={destructiveButtonClass}
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            {t("discard")}
          </button>
          <Dialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>{t(`discardTitle.${type}`)}</DialogTitle>
                <DialogDescription>{t(`discardBody.${type}`)}</DialogDescription>
              </DialogHeader>
              <ErrorText message={error} />
              <DialogFooter>
                <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => setConfirming(false)}>
                  {t("keep")}
                </button>
                <button type="button" className={destructiveButtonClass} disabled={pending} onClick={confirmDiscard}>
                  {t("discard")}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}
