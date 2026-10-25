import { getTranslations } from "next-intl/server";
import { isCommunity } from "@opengmb/core";
import { MfaVerifyForm } from "../../../components/mfa-verify-form";
import { AuthCard } from "../../../components/auth-card";

export default async function MfaVerifyPage() {
  const t = await getTranslations("authFlows");
  return (
    <AuthCard
      title={t("verify.title")}
      // A community install never had the old product name, so only the hosted server mentions it.
      description={t(isCommunity() ? "verify.description" : "verify.descriptionLegacy")}
    >
      <MfaVerifyForm />
    </AuthCard>
  );
}
