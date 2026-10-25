import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { communityActions, renderWebActions } from "../src/gen-web-actions";

// The full registry for apps/web, and the community registry for the oss/ overlay (see gen-web-actions.test.ts).
const targets = [
  { out: "../../../apps/web/app/_generated/actions.ts", text: renderWebActions() },
  { out: "../../../oss/apps/web/app/_generated/actions.ts", text: renderWebActions(communityActions()) },
];
for (const t of targets) {
  const out = fileURLToPath(new URL(t.out, import.meta.url));
  writeFileSync(out, t.text);
  console.log(`wrote ${out} (${t.text.split("export async function").length - 1} actions)`);
}
