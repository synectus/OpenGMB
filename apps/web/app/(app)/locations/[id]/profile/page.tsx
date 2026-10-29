import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import type { locationGroupsList, locationsCenterGet, locationsList, placeActionsList, profileAutoRevertGet, profileChangeSetsList, profileGet, verificationState } from "@opengmb/core";
import { PLACE_ACTION_TYPES, PROFILE_LIMITS, PROFILE_METADATA, roleHasPermission, integrationEnv } from "@opengmb/core";
import { FoodMenuEditor } from "../../../../../components/food-menu-editor";
import { PlaceActionLinks } from "../../../../../components/place-action-links";
import { ProfileEditor } from "../../../../../components/profile-editor";
import { CategorySuggestionsPanel } from "../../../../../components/profile/category-suggestions-panel";
import { GoogleManagers } from "../../../../../components/profile/google-managers";
import { AutoRevertPanel } from "../../../../../components/profile/auto-revert-panel";
import { MapPosition } from "../../../../../components/profile/map-position";
import { HowEditsWork } from "../../../../../components/profile/side-panels";
import { sectionClass } from "../../../../../components/profile/section";
import { VerificationPanel } from "../../../../../components/verification-panel";
import { actorContextFor } from "../../../../../lib/auth";
import { requireUser } from "../../../../../lib/guard";
import { liveStatus } from "../../../../../lib/live-status";
import { currentScope } from "../../../../../lib/scope-server";
import {
  locationGroups_list,
  locations_center_get,
  locations_list,
  placeActions_list,
  profile_autoRevert_get,
  profile_changeSets_list,
  profile_get,
  verification_state,
} from "../../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LocationProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("profile");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { role } = await actorContextFor(userId);
  const [r, vr, pr, cr, mc, ar] = await Promise.all([
    profile_get({ locationId: id }),
    verification_state({ locationId: id }),
    placeActions_list({ locationId: id }),
    profile_changeSets_list({ locationId: id, limit: 10 }),
    locations_center_get({ locationId: id }),
    profile_autoRevert_get({ locationId: id }),
  ]);
  const autoRevert = ar.ok ? (ar.data as Handler<typeof profileAutoRevertGet>) : null;
  if (!r.ok && r.error.code === "NOT_FOUND") notFound();
  const data = r.ok ? (r.data as Handler<typeof profileGet>) : null;
  const places = pr.ok ? (pr.data as Handler<typeof placeActionsList>) : null;
  const changeSets = cr.ok ? (cr.data as Handler<typeof profileChangeSetsList>).changeSets : [];
  const canEdit = roleHasPermission(role, "profile:edit");
  const copyTargets = canEdit && data ? await copyTargetsFor(data.location.workspaceId, id) : undefined;
  const writesOff = liveStatus(integrationEnv(), false).rows.some((row) => row.key === "writes" && row.state === "off");

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t("page.intro")}
      </p>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-4">
          {data ? (
            <ProfileEditor
              locationId={data.location.id}
              workspaceId={data.location.workspaceId}
              profile={data.profile}
              display={data.display}
              changeSets={changeSets}
              limits={{
                descriptionMax: PROFILE_LIMITS.descriptionMaxChars.limit,
                serviceDescriptionMax: PROFILE_LIMITS.serviceDescriptionMaxChars.limit,
                additionalPhonesMax: PROFILE_LIMITS.additionalPhonesMax.limit,
                areaMaxPlaces: PROFILE_LIMITS.serviceAreaMaxPlaces.limit,
                searchMinChars: PROFILE_METADATA.searchMinChars,
              }}
              canEdit={canEdit}
              canDraft={roleHasPermission(role, "review:draft")}
              copyTargets={copyTargets}
            />
          ) : (
            <section aria-label={t("page.profileLabel")} className={sectionClass}>
              <p role="alert" className="text-sm text-bad">
                <span className="font-mono">{r.ok ? "" : r.error.code}</span>: {r.ok ? "" : r.error.message}
              </p>
              {!r.ok && r.error.code === "NOT_CONFIGURED" && (
                <p className="text-sm text-muted-foreground">
                  {t("page.connectionRemoved")}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t("page.editorHidden")}</p>
            </section>
          )}
          {data && (
            <Suspense fallback={null}>
              <CategorySuggestionsPanel locationId={id} workspaceId={data.location.workspaceId} canEdit={canEdit} />
            </Suspense>
          )}
          <FoodMenuEditor locationId={id} canEdit={canEdit} />
        </div>
        <aside aria-label={t("page.aboutLabel")} className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <VerificationPanel
            locationId={id}
            state={vr.ok ? (vr.data as Handler<typeof verificationState>) : null}
            error={vr.ok ? null : `${vr.error.code}: ${vr.error.message}`}
          />
          <PlaceActionLinks
            locationId={id}
            canEdit={canEdit}
            types={PLACE_ACTION_TYPES}
            links={places?.links ?? []}
            operations={places?.operations ?? []}
            googleDenied={places?.googleAccessDenied ?? false}
            loadError={pr.ok ? null : `${pr.error.code}: ${pr.error.message}`}
          />
          <MapPosition
            locationId={id}
            center={mc.ok ? (mc.data as Handler<typeof locationsCenterGet>) : null}
            canEdit={roleHasPermission(role, "workspace:manage")}
          />
          <GoogleManagers locationId={id} />
          {autoRevert && (
            <AutoRevertPanel
              locationId={id}
              initial={{ name: autoRevert.name, phone: autoRevert.phone, address: autoRevert.address }}
              canConfigure={roleHasPermission(role, "review:configure")}
            />
          )}
          <HowEditsWork writesOff={writesOff} />
        </aside>
      </div>
    </div>
  );
}

/** The other locations of this workspace that are in the current scope: where Copy to locations can send. */
async function copyTargetsFor(workspaceId: string, sourceId: string) {
  const [locs, groups, scope] = await Promise.all([
    locations_list({ workspaceId }),
    locationGroups_list({ workspaceId }),
    currentScope(),
  ]);
  if (!locs.ok) return undefined;
  const inScope = scope.kind === "group" || scope.kind === "location" ? scope.locationIds : null;
  const others = (locs.data as Handler<typeof locationsList>).locations.filter(
    (l) => l.id !== sourceId && (inScope ? inScope.includes(l.id) : true),
  );
  return {
    workspaceId,
    locations: others.map((l) => ({
      id: l.id,
      name: l.name,
      addressSummary: l.addressSummary,
      phone: l.phone,
      status: l.status,
      googleLocationId: l.googleLocationId,
      needsRelink: l.needsRelink,
    })),
    groups: groups.ok
      ? (groups.data as Handler<typeof locationGroupsList>).groups.map((g) => ({ id: g.id, name: g.name, locationIds: g.locationIds }))
      : [],
  };
}
