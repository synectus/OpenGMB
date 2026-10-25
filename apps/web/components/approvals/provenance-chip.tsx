import { useTranslations } from "next-intl";

export function ProvenanceChip({ surface, name }: { surface: string; name: string | null }) {
  const t = useTranslations("approvals.detail");
  if (surface === "mcp") {
    return (
      <span className="inline-flex h-[22px] items-center rounded-md border border-agent-border bg-agent-bg px-2 text-[11px] font-semibold text-agent">
        {t("draftedByMcp")}
      </span>
    );
  }
  if (!name) return null;
  return (
    <span className="inline-flex h-[22px] items-center rounded-md bg-secondary px-2 text-[11px] font-semibold text-secondary-foreground">
      {name}
    </span>
  );
}
