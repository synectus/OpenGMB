import { describe, expect, it } from "vitest";
import {
  BAND_CLASS,
  bandOf,
  boundsOf,
  clampZoom,
  fitView,
  fromWorldPx,
  heatRows,
  isCentre,
  legendFor,
  mapsScriptUrl,
  MAX_ZOOM,
  MIN_ZOOM,
  pinClass,
  pinLabel,
  pinTitle,
  worldPx,
  type MapPoint,
} from "./rank-map";

/** Same spacing as core's buildGrid (radius = centre to edge), good to well under a metre here. */
function grid(lat: number, lng: number, size: number, radiusM: number): MapPoint[] {
  const R = 6_371_008.8;
  const half = (size - 1) / 2;
  const step = radiusM / half;
  const out: MapPoint[] = [];
  for (let row = 0; row < size; row++) {
    const la = lat + (((half - row) * step) / R) * (180 / Math.PI);
    for (let col = 0; col < size; col++) {
      const lo = lng + (((col - half) * step) / (R * Math.cos((la * Math.PI) / 180))) * (180 / Math.PI);
      out.push({ row, col, lat: la, lng: lo, rank: null, pending: false });
    }
  }
  return out;
}
const RIVERMOOR = { lat: 27.5306, lng: -99.4803 };

describe("bands and pins", () => {
  it("bands follow the canvas (1-3, 4-7, 8-12, 13-20, not found, pending)", () => {
    expect([1, 3, 4, 7, 8, 12, 13, 20].map((r) => bandOf(r, false))).toEqual([
      "b1", "b1", "b2", "b2", "b3", "b3", "b4", "b4",
    ]);
    expect(bandOf(null, false)).toBe("none");
    expect(bandOf(21, false)).toBe("none");
    expect(bandOf(2, true)).toBe("pending");
    expect(BAND_CLASS.b1).toBe("bg-band-1 text-band-1-foreground");
    expect(BAND_CLASS.none).toBe("bg-band-5 text-band-5-foreground");
  });

  it("labels print the rank, 20+ for not found and an ellipsis while pending", () => {
    expect(pinLabel(4, false)).toBe("4");
    expect(pinLabel(null, false)).toBe("20+");
    expect(pinLabel(null, true)).toBe("…");
  });

  it("the centre pin is the location: thick foreground ring; pending pins are dashed", () => {
    const p = (row: number, col: number, rank: number | null, pending = false): MapPoint => ({
      row, col, lat: 0, lng: 0, rank, pending,
    });
    expect(isCentre(p(3, 3, 1), 7)).toBe(true);
    expect(isCentre(p(3, 2, 1), 7)).toBe(false);
    expect(pinClass(p(3, 3, 1), 7)).toContain("border-[3px] border-foreground");
    expect(pinClass(p(0, 0, 9), 7)).toContain("border-2 border-card bg-band-3");
    expect(pinClass(p(0, 0, null, true), 7)).toContain("border-dashed border-input bg-card");
    expect(pinTitle(p(3, 3, 1), 7, "Rivermoor Main St")).toBe("Rivermoor Main St, rank 1");
    expect(pinTitle(p(0, 0, null), 7, "Rivermoor Main St")).toBe("not found");
    expect(pinTitle(p(0, 1, null, true), 7, "Rivermoor Main St")).toBe("pending");
  });

  it("heatRows is north to south, west to east; a missing point is a pending cell (denominator)", () => {
    const pts = grid(RIVERMOOR.lat, RIVERMOOR.lng, 5, 2000).filter((p) => !(p.row === 4 && p.col === 4));
    const rows = heatRows(pts, 5);
    expect(rows).toHaveLength(5);
    expect(rows.flat()).toHaveLength(25);
    expect(rows[0]![0]!.lat).toBeGreaterThan(rows[4]![0]!.lat);
    expect(rows[0]![4]!.lng).toBeGreaterThan(rows[0]![0]!.lng);
    expect(rows[4]![4]).toMatchObject({ row: 4, col: 4, pending: true, rank: null });
  });

  it("the legend adds Pending only while something is pending and always ends with the ring", () => {
    const done = [{ row: 0, col: 0, lat: 0, lng: 0, rank: 1, pending: false }];
    expect(legendFor(done).map((l) => l.label)).toEqual([
      "Rank 1 to 3",
      "4 to 7",
      "8 to 12",
      "13 to 20",
      "Not found (20+)",
      "Thick ring: the location itself",
    ]);
    expect(legendFor([{ ...done[0]!, pending: true }]).map((l) => l.label)).toContain("Pending");
  });
});

describe("Web Mercator and fitting the grid", () => {
  it("world pixels at zoom 0 put (0, 0) in the middle of the 256 px world and round-trip", () => {
    expect(worldPx(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(worldPx(0, 0, 1)).toEqual({ x: 256, y: 256 });
    const w = worldPx(RIVERMOOR.lat, RIVERMOOR.lng, 13);
    const back = fromWorldPx(w.x, w.y, 13);
    expect(back.lat).toBeCloseTo(RIVERMOOR.lat, 9);
    expect(back.lng).toBeCloseTo(RIVERMOOR.lng, 9);
  });

  it("fits a 7x7, 3 km grid at zoom 13 in the 600x520 map, 14 when wider, 12 when small", () => {
    const b = boundsOf(grid(RIVERMOOR.lat, RIVERMOOR.lng, 7, 3000));
    const v = fitView(b, 600, 520);
    expect(v.zoom).toBe(13);
    expect(v.center.lat).toBeCloseTo(RIVERMOOR.lat, 3);
    expect(v.center.lng).toBeCloseTo(RIVERMOOR.lng, 4);
    expect(fitView(b, 1200, 900).zoom).toBe(14);
    expect(fitView(b, 300, 300).zoom).toBe(12);
  });

  it("fits a 13x13, 50 km grid at zoom 9 and clamps zoom to the allowed range", () => {
    expect(fitView(boundsOf(grid(RIVERMOOR.lat, RIVERMOOR.lng, 13, 50_000)), 600, 520).zoom).toBe(9);
    expect(clampZoom(1)).toBe(MIN_ZOOM);
    expect(clampZoom(25)).toBe(MAX_ZOOM);
    expect(clampZoom(12.6)).toBe(13);
  });
});

describe("mapsScriptUrl", () => {
  it("builds the documented script URL with async loading and a callback, key encoded", () => {
    expect(mapsScriptUrl("AIza test&x", "cb")).toBe(
      "https://maps.googleapis.com/maps/api/js?key=AIza+test%26x&v=quarterly&loading=async&callback=cb",
    );
  });
});
