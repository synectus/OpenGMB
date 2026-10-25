"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { sectionId } from "./section";

/** Each menu entry jumps to the first editor section of its group. */
const ITEMS = [
  { label: "Basics", target: "Name" },
  { label: "Categories and services", target: "Categories" },
  { label: "Hours", target: "Regular hours" },
  { label: "Attributes", target: "Attributes" },
  { label: "Area", target: "Service area" },
  { label: "Contact", target: "Website, phone and opening date" },
  { label: "Address", target: "Address and store code" },
] as const;

const OFFSET = 180;

/** Sticky left menu on wide desktop, a sticky scrolling strip on phones. Highlights the section in view. */
export function ProfileSectionMenu() {
  const t = useTranslations("profile");
  const [active, setActive] = useState<string>(ITEMS[0].label);
  // The last sections can't scroll to the top of the page, so a click holds the highlight briefly.
  const holdUntil = useRef(0);

  // A link from another page (the ⌘K search) arrives with #section-...; the browser's own jump can run
  // before the editor has rendered, so scroll once it is here.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id.startsWith("section-")) document.getElementById(id)?.scrollIntoView();
  }, []);

  useEffect(() => {
    function update() {
      if (Date.now() < holdUntil.current) return;
      let current: string = ITEMS[0].label;
      for (const item of ITEMS) {
        const el = document.getElementById(sectionId(item.target));
        if (el && el.getBoundingClientRect().top <= OFFSET) current = item.label;
      }
      setActive(current);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <nav
      aria-label={t("menu.label")}
      className="sticky top-(--shell-top) z-20 -mx-1 overflow-x-auto bg-background px-1 py-2 xl:top-[calc(var(--shell-top)+1rem)] xl:mx-0 xl:w-36 xl:shrink-0 xl:overflow-visible xl:bg-transparent xl:p-0"
    >
      <ul className="flex gap-1 xl:flex-col">
        {ITEMS.map((item) => (
          <li key={item.label} className="shrink-0">
            <a
              href={`#${sectionId(item.target)}`}
              onClick={() => {
                holdUntil.current = Date.now() + 800;
                setActive(item.label);
              }}
              aria-current={active === item.label ? "true" : undefined}
              className={`block whitespace-nowrap rounded-control px-3 py-1.5 text-sm font-medium xl:whitespace-normal ${
                active === item.label ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`menu.items.${item.label}`)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
