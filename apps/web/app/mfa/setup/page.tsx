import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthError, requireAuthenticatedUser } from "@opengmb/core";
import { getAuth, userHasPassword } from "../../../lib/auth";
import { MfaSetupForm } from "../../../components/mfa-setup-form";
import { AuthCard } from "../../../components/auth-card";

// Needs a session but not MFA, so it sits outside the (app) group. The decision still
// comes from requireAuthenticatedUser: MFA_REQUIRED means "show enrolment", success means done.
export default async function MfaSetupPage() {
  const t = await getTranslations("authFlows");
  const h = await headers();
  const session = await getAuth().api.getSession({ headers: h });
  try {
    requireAuthenticatedUser(session);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    if (e.code === "UNAUTHENTICATED") redirect("/sign-in");
    // MFA_REQUIRED: fall through to enrolment
    const hasPassword = await userHasPassword(session!.user.id);
    return (
      <AuthCard
        title={t("setup.title")}
        note={t("setup.note")}
      >
        <MfaSetupForm hasPassword={hasPassword} />
      </AuthCard>
    );
  }
  redirect("/");
}
