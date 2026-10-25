import { CoreError } from "../errors";
import { GEOGRID_DEFAULTS } from "../config/geogrid";

export const EARTH_RADIUS_M = 6_371_008.8;

export type GridPoint = { row: number; col: number; lat: number; lng: number };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidGridSize(n: number): boolean {
  return Number.isInteger(n) && n >= 3 && n <= 13 && n % 2 === 1;
}

/**
 * Square n x n grid centred on (lat, lng). `radiusM` is the distance from the centre to the edge
 * row/column, so adjacent points are radiusM / ((n - 1) / 2) apart. Row 0 is the northernmost row,
 * col 0 the westernmost. Points are placed by moving north/east along the sphere from the centre.
 */
export function buildGrid(p: {
  lat: number;
  lng: number;
  size: number;
  radiusM: number;
}): GridPoint[] {
  if (!isValidGridSize(p.size)) {
    throw new CoreError("INVALID_INPUT", "Grid size must be an odd number from 3 to 13");
  }
  if (!(p.radiusM >= GEOGRID_DEFAULTS.minRadiusM && p.radiusM <= GEOGRID_DEFAULTS.maxRadiusM)) {
    throw new CoreError(
      "INVALID_INPUT",
      `Radius must be ${GEOGRID_DEFAULTS.minRadiusM} to ${GEOGRID_DEFAULTS.maxRadiusM} metres`,
    );
  }
  if (!(Math.abs(p.lat) <= 85) || !(Math.abs(p.lng) <= 180)) {
    throw new CoreError("INVALID_INPUT", "Latitude must be within +/-85 and longitude +/-180");
  }
  const half = (p.size - 1) / 2;
  const step = p.radiusM / half;
  const out: GridPoint[] = [];
  for (let row = 0; row < p.size; row++) {
    const north = (half - row) * step;
    const lat = p.lat + deg(north / EARTH_RADIUS_M);
    for (let col = 0; col < p.size; col++) {
      const east = (col - half) * step;
      const lng = p.lng + deg(east / (EARTH_RADIUS_M * Math.cos(rad(lat))));
      out.push({ row, col, lat, lng });
    }
  }
  return out;
}
