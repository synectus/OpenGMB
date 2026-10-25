import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { sectionId } from "../../lib/section-id";

export const sectionClass =
  "flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card";
export const h2Class = "font-display text-lg font-bold text-foreground";
export const fieldLabelClass = "flex flex-col gap-1 text-sm font-medium text-foreground";
// Lives in lib/ so the command palette (lib/search-targets.ts) can build the anchor without importing
// this translated component, which would pull the profile namespace into every app page.
export { sectionId } from "../../lib/section-id";

export const hintClass = "text-xs text-muted-foreground";

/**
 * Text the lib files build in English (profile-editor.ts and friends: field names, notes, values).
 * Looked up in profile.phrase, keyed by the English text without its dots; unknown text is shown as is.
 * `deep` also translates the pieces of a multi-line value ("2026-12-25 · Closed", "09:00 to 17:00"):
 * only for values the lib built, never for text a person typed.
 */
export function usePhrase(): (text: string, deep?: boolean) => string {
  const t = useTranslations("profile");
  const exact = (text: string) => {
    const key = `phrase.${text.replace(/\./g, "")}`;
    if (t.has(key)) return t(key);
    return t.has(`sections.${text}`) ? t(`sections.${text}`) : null;
  };
  return (text, deep = false) => {
    const found = exact(text);
    if (found !== null) return found;
    const day = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) hours$/.exec(text);
    if (day) return t("hours.dayHours", { day: t(`days.${day[1]!.toUpperCase()}`) });
    const attribute = /^Attribute: (.*)$/.exec(text);
    if (attribute) return t("phrase.AttributeNamed", { name: attribute[1]! });
    if (!deep) return text;
    return text
      .split("\n")
      .map((line) =>
        line
          .split(" · ")
          .map((seg) => exact(seg) ?? seg.replace(/(\d\d:\d\d) to (\d\d:\d\d)/g, (_, from: string, to: string) => t("hours.range", { from, to })))
          .join(" · "),
      )
      .join("\n");
  };
}

/** One part of the editor: a panel with an h2 and an optional badge on the right. */
export function EditorSection({
  label,
  badge,
  children,
}: {
  label: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("profile");
  // The anchor id stays the English label (the section menu and search links point at it); the text shown is translated.
  const title = t.has(`sections.${label}`) ? t(`sections.${label}`) : label;
  return (
    <section id={sectionId(label)} aria-label={title} className={`${sectionClass} scroll-mt-40`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={h2Class}>{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

/** Designed as finished, not wired yet (decision D16). */
export function NotLiveBadge() {
  const t = useTranslations("common");
  return (
    <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full bg-warn-bg px-2.5 text-xs font-bold text-warn">
      {t("notLive")}
    </span>
  );
}
