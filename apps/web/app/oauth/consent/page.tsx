import { getTranslations } from "next-intl/server";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { connectableOrgs, oauthClientName } from "@opengmb/core";
import { AuthCard } from "../../../components/auth-card";
import { OAuthConsentForm } from "../../../components/oauth-consent-form";
import { getDb } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { isKnownClientHost, redirectHostOf } from "../../../lib/oauth-consent";

export default async function OAuthConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const t = await getTranslations("oauthConsent");
  const raw = await searchParams;
  // Rebuild the signed query exactly (ba_param repeats), so the signature still verifies.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, x);
  const oauthQuery = params.toString();
  if (!(await verifyOAuthQueryParams(oauthQuery, process.env.BETTER_AUTH_SECRET!))) {
    return <AuthCard title={t("expired")}>{null}</AuthCard>;
  }
  const db = getDb();
  const host = redirectHostOf(params.get("redirect_uri"));
  const client = await oauthClientName(db, params.get("client_id") ?? "");
  const orgs = await connectableOrgs(db, user.userId);
  if (!client || !host) return <AuthCard title={t("expired")}>{null}</AuthCard>;
  if (orgs.length === 0) return <AuthCard title={t("noAccount")}>{null}</AuthCard>;
  const app = client.name?.trim() || host;
  return (
    <AuthCard title={t("title", { app })} description={t("intro", { app })}>
      <p className="text-sm">{t.rich("returnsTo", { host, strong: (c) => <strong className="font-semibold">{c}</strong> })}</p>
      {isKnownClientHost(host) ? null : (
        <p role="note" className="rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn">
          {t("unknownHost", { host })}
        </p>
      )}
      <OAuthConsentForm oauthQuery={oauthQuery} orgs={orgs} />
    </AuthCard>
  );
}
