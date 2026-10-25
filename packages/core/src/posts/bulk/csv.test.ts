import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

const cells = (text: string) => parseCsv(text).map((r) => r.cells);

describe("parseCsv", () => {
  it("keeps a comma inside quotes in one cell", () => {
    expect(cells('a,b\n"Hello, world",x')).toEqual([["a", "b"], ["Hello, world", "x"]]);
  });
  it("reads a doubled quote as one quote and keeps newlines inside quotes", () => {
    expect(cells('a\n"She said ""hi""\nsecond line"')).toEqual([["a"], ['She said "hi"\nsecond line']]);
  });
  it("strips a BOM and accepts CRLF, CR and a missing final newline", () => {
    expect(cells("﻿a,b\r\n1,2\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(cells("a\r1")).toEqual([["a"], ["1"]]);
  });
  it("skips blank lines, keeps empty cells and reports the line each record starts on", () => {
    const rows = parseCsv('a,b,c\n\n,,\n"x\ny",,z\n');
    expect(rows.map((r) => r.cells)).toEqual([["a", "b", "c"], ["x\ny", "", "z"]]);
    expect(rows.map((r) => r.line)).toEqual([1, 4]);
  });
  it("trims nothing inside cells and rejects an unterminated quote", () => {
    expect(cells("a\n  padded  ")).toEqual([["a"], ["  padded  "]]);
    expect(() => parseCsv('a\n"open')).toThrow(/quote/i);
  });
  it("returns no rows for empty text", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("﻿\n\n")).toEqual([]);
  });
});
