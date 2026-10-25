import { useTranslations } from "next-intl";
import { MCP_RESOURCES, ROLE_PERMISSIONS, roleHasPermission, type Role } from "@opengmb/core";
import { resourceAudience } from "../../lib/agents";
import { Pill } from "../page-parts";
import { Panel } from "../ui";

export function ResourcesView({ role }: { role: Role | null }) {
  const t = useTranslations("agents");
  return (
    <Panel
      title={t("resources.title")}
      description={t("resources.description", { count: MCP_RESOURCES.length })}
    >
      <ul aria-label={t("resources.title")} className="flex flex-wrap gap-3">
        {MCP_RESOURCES.map((r) => {
          const rolesWith = Object.entries(ROLE_PERMISSIONS)
            .filter(([, perms]) => perms.includes(r.permission))
            .map(([name]) => name);
          const audience = resourceAudience(rolesWith, t);
          const yours = roleHasPermission(role, r.permission);
          return (
            <li
              key={r.uri}
              className="flex flex-[1_1_260px] flex-col gap-2 rounded-xl border border-border bg-card p-4"
            >
              <strong className="font-mono text-sm">{r.name}</strong>
              <span className="text-foreground">{r.holds}</span>
              <span className="flex flex-wrap items-center gap-2">
                <Pill tone={audience === t("resources.anyRole") ? "neutral" : "warn"}>{audience}</Pill>
                <code className="font-mono text-xs text-muted-foreground">{r.permission}</code>
              </span>
              <span className="font-mono text-xs text-muted-foreground">{r.uri}</span>
              <span className="text-xs text-muted-foreground">
                {yours ? t("resources.canRead") : t("resources.cannotRead")}
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
