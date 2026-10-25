import { livePlacesTransport, placesServerKey, placesSource } from "../../places/client";
import { createDriverRegistry } from "./index";
import { liveDataForSeoTransport } from "./live-dataforseo";
import { platformDataForSeoCredentials, rankSource } from "./source";

/**
 * The registry production code uses: live DataForSEO and Places when the server has the keys, fixtures
 * otherwise, decided on every lookup. The only place production code builds live transports.
 */
export function createLiveDriverRegistry() {
  return createDriverRegistry({
    source: () => rankSource(),
    placesSource: () => placesSource(),
    liveDataForSeo: (baseUrl) =>
      liveDataForSeoTransport({ baseUrl, credentials: platformDataForSeoCredentials }),
    livePlaces: () => livePlacesTransport({ key: placesServerKey }),
  });
}
