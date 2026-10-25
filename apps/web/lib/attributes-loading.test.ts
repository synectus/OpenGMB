import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../messages";
import { AttributesSection } from "../components/profile/attributes-section";
import { attributeSummary } from "./profile-pickers";

// U2: while attribute metadata is still loading, a set attribute must read as words, never `attributes/...`.
describe("attributes while metadata is loading", () => {
  const values = { "attributes/has_wifi": { values: [true] } };

  it("summary falls back to a humanised name", () => {
    expect(attributeSummary(undefined, { values: [true] }, "attributes/has_wifi")).toBe("Has wifi: Yes");
  });

  it("the section prints no raw attribute id before metadata arrives", () => {
    const html = renderToStaticMarkup(
      createElement(
        NextIntlClientProvider,
        { locale: "en", messages: MESSAGES.en } as unknown as ComponentProps<typeof NextIntlClientProvider>,
        createElement(AttributesSection, { metas: [], values, original: values, loading: true, error: null, onChange: () => {} }),
      ),
    );
    expect(html).toContain("Has wifi: Yes"); // canary: the row did render
    expect(html).not.toContain("attributes/");
  });
});
