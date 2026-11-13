/** The grid for the scan offered before Google is connected. Our own choice, matching the defaults in quick-scan-form.tsx. */
export const FIRST_SCAN = { gridSize: 5, radiusM: 2000, speed: "standard" } as const;

export type FirstScanChoice = { placeId: string; name: string; address: string };

export function firstScanInput(workspaceId: string, choice: FirstScanChoice, keyword: string) {
  return {
    workspaceId,
    businessName: choice.name,
    placeId: choice.placeId,
    keyword: keyword.trim(),
    gridSize: FIRST_SCAN.gridSize,
    radiusM: FIRST_SCAN.radiusM,
    speed: FIRST_SCAN.speed,
  };
}

/** The scan page for a just-created quick scan. */
export const firstScanHref = (configId: string, runId?: string) =>
  `/geogrid?view=scan&config=${encodeURIComponent(configId)}${runId ? `&run=${encodeURIComponent(runId)}` : ""}`;
