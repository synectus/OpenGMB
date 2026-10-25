import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { enumLabel, isMissingTimestamp } from "@/lib/labels";
import type { verificationState } from "@opengmb/core";
import { getTimeFormat } from "../lib/time-format-server";
import { h2Class, sectionClass } from "./profile/section";
import { linkClass } from "./ui";

type State = Awaited<ReturnType<(typeof verificationState)["handler"]>>;

const STANDING: Record<string, { tone: string }> = {
  good_standing: { tone: "bg-good-bg text-good" },
  wait_for_review: { tone: "bg-warn-bg text-warn" },
  verify: { tone: "bg-warn-bg text-warn" },
  comply_with_guidelines: { tone: "bg-bad-bg text-bad" },
  resolve_ownership_conflict: { tone: "bg-bad-bg text-bad" },
  unknown: { tone: "bg-secondary text-secondary-foreground" },
};

/** Read only: Google's verification state for the location. Appeals and verification happen on Google. */
export async function VerificationPanel({
  state,
  error,
  locationId,
}: {
  state: State | null;
  error: string | null;
  locationId: string;
}) {
  const tf = await getTimeFormat();
  const t = await getTranslations("locationHub.verif");
  const yes = (b: boolean) => (b ? t("yes") : t("no"));
  const s = state ? STANDING[state.standing] : null;
  const rows: [string, string][] = state
    ? [
        [t("voiceOfMerchant"), yes(state.hasVoiceOfMerchant)],
        [t("businessAuthority"), yes(state.hasBusinessAuthority)],
        [t("waitingReview"), yes(state.waitForVoiceOfMerchant)],
        [t("needed"), `${yes(state.needsVerification)}${state.hasPendingVerification ? ` ${t("pendingNote")}` : ""}`],
        [t("comply"), yes(state.complyWithGuidelines)],
        [t("conflict"), yes(state.resolveOwnershipConflict)],
      ]
    : [];
  return (
    <section aria-labelledby="verification" className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="verification" className={h2Class}>{t("title")}</h2>
        {s && <span className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-xs font-bold ${s.tone}`}>{t(`standing.${state!.standing}`)}</span>}
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {state && (
        <>
          {state.recommendationReason && <p className="text-sm text-muted-foreground">{state.recommendationReason}</p>}
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="m-0 text-right font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          {state.verifications.length > 0 && (
            <div className="flex flex-col gap-1">
              <strong className="text-sm">{t("list")}</strong>
              <ul className="text-xs text-muted-foreground">
                {state.verifications.map((v) => (
                  <li key={v.name}>
                    {[v.method ? enumLabel(v.method) : t("unknownMethod"), v.state ? enumLabel(v.state) : t("unknown"), v.createTime && !isMissingTimestamp(v.createTime) ? tf.dateTime(v.createTime) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <Link href={`/locations/${locationId}/suspension`} className={linkClass}>
        {t("suspensionLink")}
      </Link>
      <p className="text-xs text-muted-foreground">{t("appeals")}</p>
    </section>
  );
}
