"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Horizontally scrolling, bordered table wrapper for narrow screens. When the table is wider than
 * the box the wrapper takes a tab stop, so a keyboard user can scroll it with the arrow keys
 * (WCAG 2.1.1); when it fits, it adds none.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={box}
      {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": "Table, scrolls sideways" } : {})}
      className="relative overflow-x-auto rounded-xl border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {children}
    </div>
  );
}
