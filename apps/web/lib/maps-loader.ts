// Browser only. Loads the Maps JavaScript API once per page with the documented script tag.
import { mapsScriptUrl } from "./rank-map";

const CALLBACK = "__syngmbMapsReady";
let loading: Promise<typeof google.maps> | null = null;

export function loadMapsApi(key: string): Promise<typeof google.maps> {
  const w = window as unknown as { google?: typeof google } & Record<string, unknown>;
  if (w.google?.maps?.OverlayView) return Promise.resolve(w.google.maps);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      w[CALLBACK] = () => resolve((w.google as typeof google).maps);
      const s = document.createElement("script");
      s.src = mapsScriptUrl(key, CALLBACK);
      s.async = true;
      // Same nonce as the page's own scripts, so the Content-Security-Policy accepts the Maps script
      // and the styles it adds.
      s.nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
      s.onerror = () => {
        loading = null;
        s.remove();
        reject(new Error("MAPS_LOAD_FAILED: the Google Maps script did not load."));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}
