// apps/web/app/r/[token]/not-found.tsx
import { getTranslations } from "next-intl/server";
import { Denied } from "../../../components/share/share-frame";
import { deniedCopy } from "../../../lib/share-page";

// Unknown or unusable link: 404, default SynGMB brand, nothing about whether it ever existed.
export default async function ShareNotFound() {
  const c = deniedCopy("invalid", null, await getTranslations("reports"));
  return <Denied brand={null} title={c.title} body={c.body} />;
}
