import { useTranslations } from "next-intl";
import { previewCta, previewPlace, previewWhen, type ComposeForm } from "../../lib/posts";

/** Approximate look of the post on Google. Plain text only: no aria-label repeats a field label. */
export function PostPreview({
  workspaceName,
  locationTitles,
  form,
}: {
  workspaceName: string;
  locationTitles: string[];
  form: ComposeForm;
}) {
  const t = useTranslations("posts");
  const image = form.topicType !== "ALERT" ? form.image?.sourceUrl.trim() : "";
  const cta = previewCta(t, form);
  const when = previewWhen(t, form);
  const dated = form.topicType === "EVENT" || form.topicType === "OFFER";
  return (
    <section
      aria-label={t("prev.section")}
      className="flex flex-col gap-2.5 rounded-panel border border-border bg-card p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-[17px] font-bold text-foreground">{t("prev.section")}</h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("prev.approx")}
        </span>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-border">
        <div className="flex flex-col px-3 py-2.5 leading-4">
          <strong className="text-[13px] text-foreground">{workspaceName}</strong>
          <span className="text-xs text-muted-foreground">{previewPlace(t, locationTitles)}</span>
        </div>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- any https image the author pasted
          <img src={image} alt="" className="h-48 w-full object-cover" />
        ) : null}
        <div className="flex flex-col gap-2 p-3">
          {dated && form.title ? <p className="font-semibold text-foreground">{form.title}</p> : null}
          {when ? <p className="text-xs text-muted-foreground">{when}</p> : null}
          <p className="line-clamp-4 whitespace-pre-wrap text-[13px] leading-[19px] text-foreground">
            {form.summary}
          </p>
          {cta ? (
            <span className="inline-flex h-8 items-center self-start rounded-full border border-input px-3.5 text-[13px] font-semibold text-info">
              {cta}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
