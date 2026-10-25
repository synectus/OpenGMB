import { CoreError } from "../../errors";

export type CsvRecord = { /** 1-based line the record starts on. */ line: number; cells: string[] };

/**
 * RFC 4180 CSV: quoted cells may hold commas, line breaks and "" for a quote. Accepts a BOM and
 * LF, CRLF or CR line ends. A record whose cells are all empty (a blank line, ",,") is skipped.
 */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c !== "")) records.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      startLine = line;
    } else cell += ch;
  }
  if (quoted) throw new CoreError("INVALID_INPUT", `Line ${startLine}: a quote is opened and never closed`);
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}
