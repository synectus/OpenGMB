import type { ReactNode } from "react";
import { cookies } from "next/headers";
import {
  AccessError,
  OrgSelectionRequiredError,
  emailConfigured,
  isPlatformAdmin,
  roleHasPermission,
  type Permission,
  integrationEnv,
} from "@opengmb/core";
import { ClientMessages } from "../../components/client-messages";
import { AppShell } from "../../components/app-shell";
import { NotificationBell } from "../../components/notification-bell";
import { roleLabel } from "../../lib/account";
import { actorContextFor, currentViewAs, getDb } from "../../lib/auth";
import { brandingFor } from "../../lib/branding";
import { currentDensity } from "../../lib/density";
import { requireUser } from "../../lib/guard";
import { liveStatus, liveStatusForViewer } from "../../lib/live-status";
import { pushFacts } from "../../lib/push-facts";
import { commandNavFor, navFor } from "../../lib/nav";
import { bellDataFor } from "../../lib/notifications";
import { THEME_COOKIE, parseTheme } from "../../lib/preferences";
import { TimeFormatProvider } from "../../components/time-format-provider";
import { timeFormatData } from "../../lib/time-format-server";
import { approvalSurfaces } from "../../lib/approval-surfaces";
import { scopeFilter, shellScopeOptions } from "../../lib/scope";
import { currentScope, scopeData } from "../../lib/scope-server";
import { brandCss, shellBrand } from "../../lib/theme/brand";
import { attention_counts } from "../_generated/actions";
import { NonceStyle } from "../../components/nonce-style";
import { ReadOnlyBanner } from "../../components/billing";
import { ViewAsBanner } from "../../components/view-as-banner";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { userId, email } = await requireUser();
  const [bell, branding, ctx, jar, scope, data] = await Promise.all([
    bellDataFor(userId),
    brandingFor(userId),
    // No membership yet (an invitee before /invite) or several orgs: render the shell without
    // org details. Any other error, such as a DB outage, is rethrown.
    actorContextFor(userId).catch((e: unknown) => {
      if (
        (e instanceof AccessError && e.code === "FORBIDDEN") ||
        e instanceof OrgSelectionRequiredError
      )
        return null;
      throw e;
    }),
    cookies(),
    currentScope(),
    scopeData(),
  ]);
  const role = ctx?.role ?? null;
  const can = (p: Permission) => roleHasPermission(role, p);
  // Count queries only (attention.counts). The badges count the scope's client (all clients when no
  // scope is set); a layout gets no searchParams, so this is the cookie scope.
  const badges: Record<string, number> = {};
  if (ctx) {
    const counts = await attention_counts(scope.workspaceId ? { workspaceId: scope.workspaceId } : {});
    if (counts.ok) {
      const c = counts.data as { approvals: { reply: number; post: number; changeset: number; postedit: number; total: number }; reviews: { total: number }; changes: number };
      if (roleHasPermission(role, "review:approve")) badges["/approvals"] = approvalSurfaces(c.approvals).nav;
      badges["/reviews"] = c.reviews.total;
      badges["/locations"] = c.changes;
    } else console.warn("[web] shell: attention counts unavailable", counts.error.code);
  }
  const density = await currentDensity();
  const timeData = await timeFormatData();
  const nav = navFor(can, badges);
  // The ⌘K Profile sections open on the scope's location, else the first (by name) in scope.
  const inScope = new Set(scope.locationIds);
  const profileTarget =
    ctx && !data.error
      ? (data.locations.filter((l) => inScope.has(l.id)).sort((a, b) => a.name.localeCompare(b.name))[0] ?? null)
      : null;
  const css = brandCss(branding);
  // The "what is live" badge lists setting names and server internals: platform admins only, decided
  // here so the rows never reach the RSC payload of anyone else. The banner has plain words only.
  const status = liveStatus(integrationEnv(), emailConfigured(), await pushFacts());
  const adminStatus = liveStatusForViewer(status, await isPlatformAdmin(getDb(), userId));
  // AP4: a platform admin looking at a customer's account read-only. Always null in the community edition.
  const viewing = await currentViewAs();

  return (
    <ClientMessages set="app">
    <div data-density={density}>
      {/* Agency colours: validated #rrggbb only (lib/theme/brand.ts). */}
      {css && <NonceStyle css={css} />}
      <AppShell
        email={email}
        orgLine={ctx ? `${ctx.organization.name} · ${roleLabel(ctx.role)}` : null}
        nav={nav}
        commandNav={commandNavFor(can, nav)}
        search={{ scope: scopeFilter(scope), profileTarget: profileTarget && { id: profileTarget.id, name: profileTarget.title ?? profileTarget.name } }}
        brand={shellBrand(branding)}
        status={adminStatus}
        banner={status.banner}
        theme={parseTheme(jar.get(THEME_COOKIE)?.value)}
        density={density}
        scope={ctx && data.workspaces.length > 0 && !data.error ? shellScopeOptions(data, scope.value) : null}
        ask={ctx && can("review:read") ? { client: scope.onlyWorkspaceId ? { id: scope.onlyWorkspaceId, name: data.workspaces.find((w) => w.id === scope.onlyWorkspaceId)?.name ?? scope.label } : null } : null}
        bell={bell ? <NotificationBell initial={bell} allHref="/settings/notifications" /> : null}
      >
        {viewing && <ViewAsBanner orgName={viewing.orgName} expiresAt={viewing.expiresAt} />}
        {ctx && <ReadOnlyBanner role={role} />}
        <TimeFormatProvider data={timeData}>{children}</TimeFormatProvider>
      </AppShell>
    </div>
    </ClientMessages>
  );
}
