export function dbUrlFor(url: string, dbName: string): string;
export function findEnvFile(dir: string): string | null;
export function docsOnlyDecision(files: string[]): { docsOnly: boolean; reason: string };
export function findReportLine(text: string, prefix: string): string | null;
