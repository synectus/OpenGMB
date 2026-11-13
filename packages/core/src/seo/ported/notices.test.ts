import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../../..");
const dir = path.join(__dirname, "openseo");
const HEADER = "Ported from OpenSEO (https://github.com/every-app/open-seo) at 4fa42c879fd26657aec3472dcf44f08226816df3";

describe("ported code is attributed", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const notices = readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  it("every ported file has the header and is listed in THIRD_PARTY_NOTICES.md (canary: interleave.ts)", () => {
    expect(files.length).toBeGreaterThan(0); // fail on zero
    expect(files).toContain("interleave.ts"); // canary
    for (const f of files) {
      expect(readFileSync(path.join(dir, f), "utf8"), f).toContain(HEADER);
      expect(notices, f).toContain(`packages/core/src/seo/ported/openseo/${f}`);
    }
    expect(notices).toContain("Copyright (c) 2026 Ben Senescu");
    expect(notices).toContain("Permission is hereby granted, free of charge");
    console.log(`[notices] ${files.length} ported files checked`);
  });
  it("no product file names OpenSEO (canary: a planted string is caught)", () => {
    const scan = (text: string) => /open\s?seo/i.test(text);
    expect(scan("Powered by OpenSEO")).toBe(true); // canary
    const product = [
      path.join(root, "apps/web/app/(app)/seo"),
      path.join(root, "apps/web/components/seo"),
      path.join(root, "apps/web/messages/pages/seoKeywords.ts"),
      path.join(root, "apps/web/messages/pages/seoKeywordsCost.ts"),
      path.join(root, "packages/core/src/actions/seoKeywords.ts"),
    ];
    let checked = 0;
    const walk = (p: string) => {
      const st = statSync(p);
      if (st.isDirectory()) return readdirSync(p).forEach((c) => walk(path.join(p, c)));
      checked++;
      expect(scan(readFileSync(p, "utf8")), p).toBe(false);
    };
    product.forEach(walk);
    expect(checked).toBeGreaterThan(0);
    console.log(`[notices] ${checked} product files scanned for the OpenSEO name`);
  });
});
