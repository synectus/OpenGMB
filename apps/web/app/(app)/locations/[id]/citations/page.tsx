import { notFound } from "next/navigation";
import type { citationsList } from "@opengmb/core";
import { CITATION_COUNTRIES, roleHasPermission } from "@opengmb/core";
import { CitationTracker } from "../../../../../components/citation-tracker";
import { ErrorText } from "../../../../../components/ui";
import { actorContextFor } from "../../../../../lib/auth";
import { requireUser } from "../../../../../lib/guard";
import { isUuid } from "../../../../../lib/locations";
import { citations_list } from "../../../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

export default async function LocationCitationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ country?: string }>;
}) {
  const { userId } = await requireUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const wanted = (await searchParams).country?.toUpperCase();
  const country = wanted && CITATION_COUNTRIES.includes(wanted) ? wanted : undefined;
  const { role } = await actorContextFor(userId);
  const r = await citations_list({ locationId: id, ...(country ? { country } : {}) });
  if (!r.ok) return <ErrorText message={`${r.error.code}: ${r.error.message}`} />;
  const d = r.data as Handler<typeof citationsList>;
  return (
    <CitationTracker
      locationId={id}
      canEdit={roleHasPermission(role, "profile:edit")}
      country={d.country}
      countries={CITATION_COUNTRIES}
      countryFallback={d.countrySource === "fallback"}
      verifiedOn={d.listVerifiedOn}
      defaults={{ name: d.location.name, address: d.location.addressSummary ?? "", phone: d.location.phone ?? "" }}
      sites={d.sites}
      custom={d.custom}
    />
  );
}
