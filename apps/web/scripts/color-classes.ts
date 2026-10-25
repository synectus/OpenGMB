// Maps hard-coded Tailwind palette classes onto design tokens (lib/theme/tokens.ts) and checks
// none come back. Usage: pnpm --filter @opengmb/web check:colors [--write]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["app", "components"];
const EXCLUDE = new Set(["app/_generated", "components/primitives"]);
export const SCOPE = `${SCAN_DIRS.map((d) => `${d}/`).join(", ")} (.ts, .tsx; excludes ${[...EXCLUDE].join(", ")})`;

/** Exact class → token class. Context-dependent ones (text-white, heatmap bands) were fixed by hand. */
export const MAP: Record<string, string> = {
  "text-slate-900": "text-foreground",
  "text-gray-900": "text-foreground",
  "text-slate-800": "text-foreground",
  "text-gray-800": "text-foreground",
  "text-black": "text-foreground",
  "text-slate-700": "text-muted-foreground",
  "text-gray-700": "text-muted-foreground",
  "text-slate-600": "text-muted-foreground",
  "text-gray-600": "text-muted-foreground",
  "text-slate-500": "text-muted-foreground",
  "text-gray-500": "text-muted-foreground",
  "text-slate-400": "text-muted-foreground",
  "text-gray-400": "text-muted-foreground",
  "text-red-700": "text-bad",
  "text-red-800": "text-bad",
  "text-red-900": "text-bad",
  "text-amber-600": "text-warn",
  "text-amber-800": "text-warn",
  "text-amber-900": "text-warn",
  "text-green-700": "text-good",
  "text-green-800": "text-good",
  "text-green-900": "text-good",
  "text-blue-800": "text-info",
  "text-blue-900": "text-info",
  "bg-white": "bg-card",
  "bg-slate-50": "bg-muted",
  "bg-gray-50": "bg-muted",
  "bg-slate-100": "bg-secondary",
  "bg-gray-100": "bg-secondary",
  "bg-gray-200": "bg-secondary",
  "bg-slate-900": "bg-foreground",
  "bg-red-50": "bg-bad-bg",
  "bg-red-100": "bg-bad-bg",
  "bg-amber-100": "bg-warn-bg",
  "bg-green-50": "bg-good-bg",
  "bg-green-100": "bg-good-bg",
  "bg-blue-50": "bg-info-bg",
  "bg-blue-100": "bg-info-bg",
  "bg-red-700": "bg-destructive",
  "border-slate-100": "border-border",
  "border-slate-200": "border-border",
  "border-gray-200": "border-border",
  "border-slate-300": "border-input",
  "border-gray-300": "border-input",
  "border-gray-400": "border-input",
  "border-gray-500": "border-input",
  "border-slate-900": "border-foreground",
  "border-black": "border-foreground",
  "border-red-300": "border-bad-border",
  "border-red-400": "border-bad-border",
  "border-red-700": "border-bad",
  "border-green-600": "border-good",
  "border-green-700": "border-good",
  "border-blue-700": "border-info",
  "divide-slate-100": "divide-border",
  "ring-slate-900": "ring-foreground",
  "outline-slate-500": "outline-ring",
  "bg-[var(--brand-primary,#000)]": "bg-primary",
  "bg-[var(--brand-primary,#0f172a)]": "bg-primary",
  "border-[var(--brand-primary,#0f172a)]": "border-primary",
  "outline-[var(--brand-primary,#0f172a)]": "outline-ring",
};

const PALETTE =
  /^(bg|text|border|ring|ring-offset|outline|divide|fill|stroke|accent|shadow|from|via|to|placeholder|caret|decoration)-(slate|gray|zinc|neutral|stone|white|black|red|amber|green|blue|yellow|emerald|orange|lime|sky|indigo|rose|purple|pink|violet|cyan|teal|fuchsia)(-\d{2,3})?(\/(\d+|\[[^\]]+\]))?$/;

const HEX = /^(bg|text|border|ring|outline|divide|fill|stroke|from|via|to|decoration|caret|accent|shadow)-\[#[0-9a-fA-F]{3,8}\]$/;

/** Splits "hover:focus-visible:bg-x" into ["hover:focus-visible:", "bg-x"], ignoring ":" inside [...]. */
function splitVariant(token: string): [string, string] {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ":" && depth === 0) cut = i;
  }
  return [token.slice(0, cut + 1), token.slice(cut + 1)];
}

const SEPARATORS = new Set([" ", "\t", "\r", '"', "'", "`", "$", "{", "}", ","]);

/** Calls fn on each class token and rebuilds the text. Separators inside [...] do not split (var(--x,#000)). */
function mapTokens(line: string, fn: (token: string) => string): string {
  let out = "";
  let start = -1;
  let depth = 0;
  const flush = (end: number) => {
    if (start >= 0) out += fn(line.slice(start, end));
    start = -1;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && SEPARATORS.has(c)) {
      flush(i);
      out += c;
    } else if (start < 0) start = i;
  }
  flush(line.length);
  return out;
}

const isComment = (line: string) => /^(\/\/|\*)/.test(line.trim());

/** Strips one leading or trailing "!" (Tailwind important modifier). */
function splitBang(base: string): [string, string, string] {
  const pre = base.startsWith("!") ? "!" : "";
  const rest = base.slice(pre.length);
  const post = rest.endsWith("!") ? "!" : "";
  return [pre, rest.slice(0, rest.length - post.length), post];
}

export type Finding = { file: string; line: number; token: string; base: string };

export function findRaw(text: string, file = "<text>"): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((lineText, i) => {
    if (isComment(lineText)) return;
    mapTokens(lineText, (token) => {
      const [, withBang] = splitVariant(token);
      const [, base] = splitBang(withBang);
      if (PALETTE.test(base) || HEX.test(base) || base.includes("var(--brand-")) {
        out.push({ file, line: i + 1, token, base });
      }
      return token;
    });
  });
  return out;
}

export function rewrite(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      isComment(line)
        ? line
        : mapTokens(line, (token) => {
            const [prefix, withBang] = splitVariant(token);
            const [pre, base, post] = splitBang(withBang);
            const to = Object.hasOwn(MAP, base) ? MAP[base] : undefined;
            return to ? prefix + pre + to + post : token;
          }),
    )
    .join("\n");
}

function listFiles(dir: string): string[] {
  const rel = relative(WEB_ROOT, dir);
  if (EXCLUDE.has(rel)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listFiles(full);
    return /\.(tsx|ts)$/.test(name) && !name.endsWith(".test.ts") ? [full] : [];
  });
}

export function scanRepo(write = false): { files: number; changed: number; findings: Finding[] } {
  const files = SCAN_DIRS.flatMap((d) => listFiles(join(WEB_ROOT, d)));
  let changed = 0;
  const findings: Finding[] = [];
  for (const full of files) {
    let text = readFileSync(full, "utf8");
    if (write) {
      const next = rewrite(text);
      if (next !== text) {
        writeFileSync(full, next);
        changed++;
        text = next;
      }
    }
    findings.push(...findRaw(text, relative(WEB_ROOT, full)));
  }
  return { files: files.length, changed, findings };
}

// Run as a CLI only when executed directly (tsx scripts/color-classes.ts), never when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, changed, findings } = scanRepo(process.argv.includes("--write"));
  for (const f of findings) console.log(`${f.file}:${f.line} ${f.token}`);
  console.log(`${files} files scanned in ${SCOPE}, ${changed} rewritten, ${findings.length} raw colour classes left`);
  if (files === 0 || findings.length > 0) process.exit(1);
}
