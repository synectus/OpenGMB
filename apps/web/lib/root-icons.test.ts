import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("next/font/google", () => ({ Inter: () => ({ variable: "" }), Plus_Jakarta_Sans: () => ({ variable: "" }), Noto_Sans_Devanagari: () => ({ variable: "" }) }));
import { metadata } from "../app/layout";

describe("root metadata icons", () => {
  it("exposes the svg, the 192 png and the 48px ico, plus the apple touch icon", () => {
    const icons = metadata.icons as { icon: { url: string; sizes?: string; type?: string }[]; apple: string };
    expect(icons.icon.map((i) => i.url)).toEqual(["/icons/icon.svg", "/icons/icon-192.png", "/favicon.ico"]);
    expect(icons.icon[2]?.sizes).toBe("48x48");
    expect(icons.apple).toBe("/icons/apple-touch-icon.png");
  });
  it("favicon.ico is an ICO with 16, 32 and 48 px entries", () => {
    const b = readFileSync(new URL("../public/favicon.ico", import.meta.url));
    expect([b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4)]).toEqual([0, 1, 3]);
    expect([0, 1, 2].map((i) => b[6 + 16 * i])).toEqual([16, 32, 48]);
  });
});
