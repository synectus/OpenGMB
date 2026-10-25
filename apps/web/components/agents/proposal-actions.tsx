"use client";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { mcp_proposals_apply, mcp_proposals_cancel } from "../../app/_generated/actions";
import { ErrorText, buttonClass, secondaryButtonClass } from "../ui";

export function ProposalActions({ proposalId, canApply }: { proposalId: string; canApply: boolean }) {
  const t = useTranslations("agents");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(kind: "apply" | "cancel") {
    if (kind === "cancel" && !window.confirm(t("proposals.confirmCancel"))) {
      return;
    }
    setPending(true);
    setError(null);
    const r =
      kind === "apply"
        ? await mcp_proposals_apply({ proposalId })
        : await mcp_proposals_cancel({ proposalId });
    setPending(false);
    if (!r.ok) return setError(`${r.error.code}: ${r.error.message}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {canApply && (
          <button type="button" className={buttonClass} disabled={pending} onClick={() => run("apply")}>
            {t("proposals.apply")}
          </button>
        )}
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={pending}
          onClick={() => run("cancel")}
        >
          {t("proposals.cancel")}
        </button>
      </div>
      <span className="text-xs text-muted-foreground">
        {canApply
          ? t("proposals.applyNote")
          : t("proposals.revokedNote")}
      </span>
      <ErrorText message={error} />
    </div>
  );
}
