import { getTranslations } from "next-intl/server";
import Link from "next/link";
import type { locationsHealthcheck } from "@opengmb/core";
import { locations_healthcheck } from "../../app/_generated/actions";
import { quickWins } from "../../lib/rank-tracking";
import { ErrorText } from "../ui";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

/** Async server component: runs the Health check live (about 7 Google reads); streamed in Suspense. */
export async function QuickWins({ locationId }: { locationId: string }) {
  const t = await getTranslations("geogrid");
  const r = await locations_healthcheck({ locationId });
  if (!r.ok) return <ErrorText message={`${r.error.code}: ${r.error.message}`} />;
  const wins = quickWins((r.data as Handler<typeof locationsHealthcheck>).checks, 3, t);
  return (
    <div className="flex flex-col gap-2">
      {wins.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("quickWins.allPass")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {wins.map((w) => (
            <li key={w.id}>
              <Link
                href={w.href}
                className="inline-flex min-h-9 items-center gap-2 rounded-full border border-input bg-card px-3.5 py-1.5 text-[13px] font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {w.text}
                <span className="text-xs font-bold text-brand-text">{w.dest}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href={`/locations/${locationId}/health`} className="text-xs text-muted-foreground underline">
        {t("quickWins.from")}
      </Link>
    </div>
  );
}
