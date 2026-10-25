"use client";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadMapsApi } from "../../lib/maps-loader";
import {
  boundsOf,
  clampZoom,
  fitView,
  isCentre,
  MAX_ZOOM,
  MIN_ZOOM,
  pinClass,
  pinLabel,
  type MapPoint,
} from "../../lib/rank-map";
import { SampleBadge } from "./badges";

const MAP_HEIGHT = 520;
const KEY_REJECTED = "MAPS_KEY_REJECTED";
const iconButton =
  "inline-flex size-9 items-center justify-center rounded-control border border-input bg-card text-foreground shadow-card hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-card px-2.5 py-0.5 text-xs font-bold text-foreground shadow-card";

type Layer = { pane: HTMLElement; proj: google.maps.MapCanvasProjection; maps: typeof google.maps };

function PinIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
    </svg>
  );
}

export function RankMap({
  apiKey,
  missingKeyHint,
  size,
  points,
  targetName,
  runLabel,
  sample,
}: {
  apiKey: string | null;
  /** Shown when there is no key: owners and admins get the env name, others a plain sentence. */
  missingKeyHint: string;
  size: number;
  points: MapPoint[];
  targetName: string;
  /** "Run 2026-10-14 09:00", in the client's zone */
  runLabel: string;
  sample: boolean;
}) {
  const t = useTranslations("geogrid");
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [layer, setLayer] = useState<Layer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { north, south, east, west } = boundsOf(points);

  useEffect(() => {
    const box = boxRef.current;
    if (!apiKey || !box) return;
    let cancelled = false;
    let overlay: google.maps.OverlayView | null = null;
    // Google calls this global when it refuses the key (referrer, API not enabled, billing).
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () =>
      setError(KEY_REJECTED);
    loadMapsApi(apiKey).then(
      (maps) => {
        if (cancelled) return;
        const view = fitView({ north, south, east, west }, box.clientWidth, MAP_HEIGHT);
        const map = new maps.Map(box, {
          center: view.center,
          zoom: view.zoom,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          // Our Zoom in / Zoom out buttons replace Google's; attribution,
          // keyboard shortcuts and fullscreen stay.
          zoomControl: false,
          streetViewControl: false,
          mapTypeControl: false,
          clickableIcons: false,
          gestureHandling: "cooperative",
        });
        mapRef.current = map;
        class PinLayer extends maps.OverlayView {
          onAdd() {}
          draw() {
            const pane = this.getPanes()?.overlayLayer as HTMLElement | undefined;
            if (pane) setLayer({ pane, proj: this.getProjection(), maps });
          }
          onRemove() {
            setLayer(null);
          }
        }
        overlay = new PinLayer();
        overlay.setMap(map);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
      overlay?.setMap(null);
      mapRef.current = null;
    };
  }, [apiKey, north, south, east, west]);

  const zoomBy = (d: number) => {
    const m = mapRef.current;
    if (m) m.setZoom(clampZoom((m.getZoom() ?? 13) + d));
  };
  const fit = () => {
    const m = mapRef.current;
    const box = boxRef.current;
    if (!m || !box) return;
    const v = fitView({ north, south, east, west }, box.clientWidth, MAP_HEIGHT);
    m.setCenter(v.center);
    m.setZoom(v.zoom);
  };

  const live = apiKey !== null && error === null;
  const centre = points.find((p) => isCentre(p, size)) ?? null;
  const px = (p: MapPoint) =>
    layer ? layer.proj.fromLatLngToDivPixel(new layer.maps.LatLng(p.lat, p.lng)) : null;

  return (
    <figure
      aria-label={t("map.label")}
      className="relative m-0 h-[520px] w-full overflow-hidden rounded-panel border border-border bg-muted"
    >
      {live && <div ref={boxRef} className="absolute inset-0" />}

      {live &&
        layer &&
        createPortal(
          <>
            {points.map((p) => {
              const at = px(p);
              return (
                <span
                  key={`${p.row}:${p.col}`}
                  aria-hidden
                  className={`absolute -translate-x-1/2 -translate-y-1/2 ${pinClass(p, size)}`}
                  style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
                >
                  {pinLabel(p.rank, p.pending)}
                </span>
              );
            })}
            {centre && (
              <span
                aria-hidden
                className={`absolute -translate-x-1/2 -translate-y-[calc(100%+24px)] ${chip}`}
                style={{ left: px(centre)?.x ?? 0, top: px(centre)?.y ?? 0 }}
              >
                <PinIcon />
                {targetName}
              </span>
            )}
          </>,
          layer.pane,
        )}

      {!live && (
        <>
          <div
            aria-hidden
            className="absolute inset-x-[16%] inset-y-[10%] grid place-items-center"
            style={{
              gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${size}, minmax(0, 1fr))`,
            }}
          >
            {points.map((p) => (
              <span key={`${p.row}:${p.col}`} className={pinClass(p, size)}>
                {pinLabel(p.rank, p.pending)}
              </span>
            ))}
          </div>
          <span
            aria-hidden
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[calc(100%+24px)] ${chip}`}
          >
            <PinIcon />
            {targetName}
          </span>
          <p className="absolute inset-x-3 bottom-2.5 text-xs text-muted-foreground">
            <strong className="text-foreground">
              {error ? t("map.couldNotLoad") : t("map.notSetUp")}
            </strong>{" "}
            {error === KEY_REJECTED ? t("map.keyRejected") : (error ?? missingKeyHint)} {t("map.ranksBelow")}
          </p>
        </>
      )}

      <span className={`absolute left-3 top-3 ${chip} tabular-nums`}>{runLabel}</span>
      {sample && (
        <span className="absolute right-3 top-3">
          <SampleBadge />
        </span>
      )}
      {live && (
        <div className="absolute bottom-3 right-3 flex flex-col gap-1.5">
          <button type="button" aria-label={t("map.zoomIn")} className={iconButton} onClick={() => zoomBy(1)}>
            <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button type="button" aria-label={t("map.zoomOut")} className={iconButton} onClick={() => zoomBy(-1)}>
            <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M5 12h14" />
            </svg>
          </button>
          <button type="button" aria-label={t("map.fit")} className={iconButton} onClick={fit}>
            <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </svg>
          </button>
        </div>
      )}
    </figure>
  );
}
