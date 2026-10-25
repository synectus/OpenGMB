import type { workspaceSettingsGet } from "@opengmb/core";
import { getTranslations } from "next-intl/server";
import { workspaceSettings_get } from "../app/_generated/actions";
import { autoApproveChipParts } from "../lib/approvals";
import { AutoApproveChipView } from "./auto-approve-chip-view";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

/** "Auto-approve 5★ is on in N workspaces", linking to the reply settings. Renders nothing when no workspace has the rule. */
export async function AutoApproveChip({ workspaceIds }: { workspaceIds: string[] }) {
  const results = await Promise.all(
    workspaceIds.map((workspaceId) => workspaceSettings_get({ workspaceId })),
  );
  const stars = results.flatMap((r) =>
    r.ok ? [(r.data as Handler<typeof workspaceSettingsGet>).autoApproveMinStars] : [],
  );
  const parts = autoApproveChipParts(stars);
  if (!parts) return null;
  const t = await getTranslations("approvals.autoApprove");
  const text = t("chip", { rule: t(parts.rule), count: parts.count });
  return <AutoApproveChipView text={text} href="/settings/workspace" />;
}
