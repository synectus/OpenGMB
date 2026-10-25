// Gzipped JavaScript per page against a production build (`next build`, then `next start`).
// Usage: tsx scripts/js-budget.ts http://localhost:3099 /docs /docs/mcp /docs/mcp/tools
// The e2e suite runs `next dev`, whose unminified bundles would fail any budget, so this is run by hand.
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";

const BUDGET_KB = 170; // SEO addendum section 6

const [base, ...paths] = process.argv.slice(2);
if (!base || paths.length === 0) {
  console.error("usage: tsx scripts/js-budget.ts <base-url> <path>...");
  process.exit(2);
}

const browser = await chromium.launch();
let failed = false;
try {
  for (const path of paths) {
    const page = await browser.newPage();
    const sizes = new Map<string, number>();
    page.on("response", async (res) => {
      const type = res.headers()["content-type"] ?? "";
      if (!/javascript/.test(type)) return;
      try {
        sizes.set(res.url(), gzipSync(await res.body()).length);
      } catch {
        /* a response that vanished during navigation */
      }
    });
    await page.goto(new URL(path, base).toString(), { waitUntil: "networkidle" });
    await page.close();
    const total = [...sizes.values()].reduce((a, b) => a + b, 0);
    const kb = total / 1024;
    console.log(`js budget ${path}: ${sizes.size} scripts, ${kb.toFixed(1)} KB gzipped of ${BUDGET_KB}`);
    if (sizes.size === 0) {
      console.error(`${path}: measured zero scripts; the check is broken, not the page`);
      failed = true;
    } else if (total > BUDGET_KB * 1024) {
      console.error(`${path}: over budget`);
      failed = true;
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
