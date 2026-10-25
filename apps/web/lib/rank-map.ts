// Pure helpers for the rank map and its table: bands, pins, legend, Web Mercator fit, script URL.
// No React, no DOM, no Google object: everything here is unit tested.
import { enT, type Tr } from "./rank-tracking";

export type MapPoint = {
  row: number;
  col: number;
  lat: number;
  lng: number;
  /** null = not found in the top 20 (or not collected yet, then `pending`). */
  rank: number | null;
  pending: boolean;
};

export type Band = "b1" | "b2" | "b3" | "b4" | "none" | "pending";

export function bandOf(rank: number | null, pending: boolean): Band {
  if (pending) return "pending";
  if (rank === null || rank > 20) return "none";
  if (rank <= 3) return "b1";
  if (rank <= 7) return "b2";
  if (rank <= 12) return "b3";
  return "b4";
}

/** Fill and text only; borders depend on where the band is drawn. */
export const BAND_CLASS: Record<Band, string> = {
  b1: "bg-band-1 text-band-1-foreground",
  b2: "bg-band-2 text-band-2-foreground",
  b3: "bg-band-3 text-band-3-foreground",
  b4: "bg-band-4 text-band-4-foreground",
  none: "bg-band-5 text-band-5-foreground",
  pending: "bg-card text-muted-foreground",
};

export function pinLabel(rank: number | null, pending: boolean): string {
  if (pending) return "…";
  if (rank === null || rank > 20) return "20+";
  return String(rank);
}

/** The grid is centred on the location, so the middle point is the location itself. */
export function isCentre(p: { row: number; col: number }, size: number): boolean {
  const half = (size - 1) / 2;
  return p.row === half && p.col === half;
}

export function pinClass(p: MapPoint, size: number): string {
  const border = isCentre(p, size)
    ? "border-[3px] border-foreground"
    : p.pending
      ? "border-2 border-dashed border-input"
      : "border-2 border-card";
  return `flex size-10 items-center justify-center rounded-full ${border} ${BAND_CLASS[bandOf(p.rank, p.pending)]} text-[13px] font-bold tabular-nums shadow-card`;
}

export function pinTitle(p: MapPoint, size: number, targetName: string, t: Tr = enT): string {
  const what = p.pending
    ? t("pin.pending")
    : p.rank === null || p.rank > 20
      ? t("pin.notFound")
      : t("pin.rank", { rank: p.rank });
  return isCentre(p, size) ? t("pin.centre", { name: targetName, what }) : what;
}

/** Rows north to south, each west to east. A point the run does not have yet is a pending cell. */
export function heatRows(points: MapPoint[], size: number): MapPoint[][] {
  const by = new Map(points.map((p) => [`${p.row}:${p.col}`, p]));
  return Array.from({ length: size }, (_, row) =>
    Array.from(
      { length: size },
      (_, col) => by.get(`${row}:${col}`) ?? { row, col, lat: 0, lng: 0, rank: null, pending: true },
    ),
  );
}

export type LegendItem = { band: Band | "ring"; label: string };

export function legendFor(points: MapPoint[], t: Tr = enT): LegendItem[] {
  return [
    { band: "b1", label: t("legend.b1") },
    { band: "b2", label: t("legend.b2") },
    { band: "b3", label: t("legend.b3") },
    { band: "b4", label: t("legend.b4") },
    { band: "none", label: t("legend.none") },
    ...(points.some((p) => p.pending) ? [{ band: "pending" as const, label: t("legend.pending") }] : []),
    { band: "ring", label: t("legend.ring") },
  ];
}

// --- Web Mercator: the projection Google Maps uses. The world is 256 * 2^zoom pixels wide. ---

const TILE = 256;
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 18;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function worldPx(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const s = Math.min(Math.max(Math.sin(rad(lat)), -0.9999), 0.9999);
  const scale = TILE * 2 ** zoom;
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

export function fromWorldPx(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const scale = TILE * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: deg(Math.atan(Math.sinh(n))), lng: (x / scale) * 360 - 180 };
}

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));

export type Bounds = { north: number; south: number; east: number; west: number };

export function boundsOf(points: { lat: number; lng: number }[]): Bounds {
  if (points.length === 0) return { north: 0, south: 0, east: 0, west: 0 };
  return {
    north: Math.max(...points.map((p) => p.lat)),
    south: Math.min(...points.map((p) => p.lat)),
    east: Math.max(...points.map((p) => p.lng)),
    west: Math.min(...points.map((p) => p.lng)),
  };
}

/**
 * Centre and the largest whole zoom at which the bounds fit inside the map with `paddingPx` on each
 * side (48 px keeps the 40 px edge pins inside). Same idea as Map.fitBounds, but deterministic.
 */
export function fitView(
  b: Bounds,
  widthPx: number,
  heightPx: number,
  paddingPx = 48,
): { center: { lat: number; lng: number }; zoom: number } {
  const nw = worldPx(b.north, b.west, 0);
  const se = worldPx(b.south, b.east, 0);
  const center = fromWorldPx((nw.x + se.x) / 2, (nw.y + se.y) / 2, 0);
  const dx = se.x - nw.x;
  const dy = se.y - nw.y;
  const w = Math.max(1, widthPx - 2 * paddingPx);
  const h = Math.max(1, heightPx - 2 * paddingPx);
  const z = Math.min(dx > 0 ? Math.log2(w / dx) : MAX_ZOOM, dy > 0 ? Math.log2(h / dy) : MAX_ZOOM);
  return { center, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(z))) };
}

/** Google's documented direct script tag with async loading. `v=quarterly` changes less often than weekly. */
export function mapsScriptUrl(key: string, callback: string): string {
  const q = new URLSearchParams({ key, v: "quarterly", loading: "async", callback });
  return `https://maps.googleapis.com/maps/api/js?${q.toString()}`;
}
