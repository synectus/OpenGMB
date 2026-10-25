"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  posts_approve,
  posts_approveEdit,
  posts_reject,
  posts_rejectEdit,
  profile_approve,
  profile_reject,
  reviewReplies_approve,
  reviewReplies_reject,
} from "../app/_generated/actions";
import { buttonClass, ErrorText, secondaryButtonClass } from "./ui";

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

/**
 * Approve / send back with an always-visible reason (the Approvals page, whose S key focuses it).
 * Whether it shows is core's can.* flag; core enforces it again on click. The portal uses
 * PortalDecision instead.
 */
export function ApprovalActions({
  type,
  id,
  redirectTo,
}: {
  type: ApprovalType;
  id: string;
  redirectTo: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");

  async function act(kind: "approve" | "reject") {
    setPending(true);
    setError(null);
    const result = await decide(type, kind, id, reason.trim());
    setPending(false);
    if (!result.ok) return setError(`${result.error.code}: ${result.error.message}`);
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <ErrorText message={error} />
      <div className="flex flex-wrap items-end gap-2.5">
        <button
          type="button"
          data-approval-action="approve"
          className={buttonClass}
          disabled={pending}
          onClick={() => act("approve")}
        >
          Approve
        </button>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs font-semibold">
          Reason for sending back
          <input
            type="text"
            data-approval-reason
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            placeholder="Tell the writer what to change"
            className="min-h-(--control-h) rounded-lg border border-input bg-card px-3 text-sm font-normal text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={pending || reason.trim() === ""}
          onClick={() => act("reject")}
        >
          Send back
        </button>
      </div>
    </div>
  );
}
