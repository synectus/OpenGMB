import { DFS_COUNTRY_LOCATIONS } from "./dfs-locations";

/**
 * X1a citation tracker: business directories and listing sites a business can claim by hand, per
 * country. The countries are the ones in dfs-locations.ts; a location with no or an unlisted country
 * gets the fallback region's list (the same fallback as dfsLocationCodeFor).
 *
 * Every site's `sourceUrl` is its own sign-up or claim page, fetched on `verifiedOn`. Sites whose
 * host answered with a bot block (HTTP 403 or a connection reset) kept their entry because the host
 * resolved and is a known operating directory; sites with no DNS, a broken certificate or a redirect
 * to an unrelated brand were dropped. Re-check the list before relying on it: directories close
 * and move, and a dead link here is a wrong instruction on the page.
 */
export const CITATION_SITES_VERIFIED_ON = "2026-10-24";

export type CitationSiteType = "core" | "general" | "social" | "maps";

export type CitationSite = {
  /** Stable id stored with a tracker entry; never reuse or rename one. */
  key: string;
  name: string;
  /** Where the business signs up or claims the listing. */
  claimUrl: string;
  /** Page the facts above were read from (the site's own claim page). */
  sourceUrl: string;
  cost: "free" | "paid";
  /** core = data aggregators others copy from; maps = map apps; social = profile networks. */
  type: CitationSiteType;
  /** 1 = do first, 3 = optional. */
  priority: 1 | 2 | 3;
  countries: readonly string[];
};

export const CITATION_SITES: readonly CitationSite[] = [
  { key: "apple-business-connect", name: "Apple Business Connect", claimUrl: "https://businessconnect.apple.com/", sourceUrl: "https://businessconnect.apple.com/", cost: "free", type: "maps", priority: 1, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "bbb", name: "Better Business Bureau", claimUrl: "https://www.bbb.org/get-listed", sourceUrl: "https://www.bbb.org/get-listed", cost: "free", type: "general", priority: 1, countries: ["US", "CA"] },
  { key: "bing-places", name: "Bing Places for Business", claimUrl: "https://www.bingplaces.com/", sourceUrl: "https://www.bingplaces.com/", cost: "free", type: "maps", priority: 1, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "expressupdate", name: "Data Axle Express Update", claimUrl: "https://www.expressupdate.com/", sourceUrl: "https://www.expressupdate.com/", cost: "free", type: "core", priority: 1, countries: ["US"] },
  { key: "facebook-page", name: "Facebook Business Page", claimUrl: "https://www.facebook.com/pages/create", sourceUrl: "https://www.facebook.com/pages/create", cost: "free", type: "social", priority: 1, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "finda", name: "Finda", claimUrl: "https://www.finda.co.nz/", sourceUrl: "https://www.finda.co.nz/", cost: "free", type: "general", priority: 1, countries: ["NZ"] },
  { key: "foursquare", name: "Foursquare", claimUrl: "https://foursquare.com/add-place", sourceUrl: "https://foursquare.com/add-place", cost: "free", type: "core", priority: 1, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "justdial", name: "Justdial", claimUrl: "https://www.justdial.com/Free-Listing", sourceUrl: "https://www.justdial.com/Free-Listing", cost: "free", type: "general", priority: 1, countries: ["IN"] },
  { key: "localeze", name: "Neustar Localeze", claimUrl: "https://www.neustarlocaleze.biz/welcome", sourceUrl: "https://www.neustarlocaleze.biz/welcome", cost: "free", type: "core", priority: 1, countries: ["US", "CA"] },
  { key: "mappls", name: "Mappls (MapmyIndia)", claimUrl: "https://www.mappls.com/", sourceUrl: "https://www.mappls.com/", cost: "free", type: "maps", priority: 1, countries: ["IN"] },
  { key: "sulekha", name: "Sulekha", claimUrl: "https://www.sulekha.com/", sourceUrl: "https://www.sulekha.com/", cost: "free", type: "general", priority: 1, countries: ["IN"] },
  { key: "truelocal", name: "True Local", claimUrl: "https://www.truelocal.com.au/", sourceUrl: "https://www.truelocal.com.au/", cost: "free", type: "general", priority: 1, countries: ["AU"] },
  { key: "yell", name: "Yell", claimUrl: "https://www.yell.com/free-listing/", sourceUrl: "https://www.yell.com/free-listing/", cost: "free", type: "general", priority: 1, countries: ["GB"] },
  { key: "yellow-nz", name: "Yellow New Zealand", claimUrl: "https://www.yellow.co.nz/", sourceUrl: "https://www.yellow.co.nz/", cost: "free", type: "general", priority: 1, countries: ["NZ"] },
  { key: "yellow-pages-ae", name: "Yellow Pages UAE", claimUrl: "https://www.yellowpages.ae/", sourceUrl: "https://www.yellowpages.ae/", cost: "free", type: "general", priority: 1, countries: ["AE"] },
  { key: "yellowpages-au", name: "Yellow Pages Australia", claimUrl: "https://www.yellowpages.com.au/", sourceUrl: "https://www.yellowpages.com.au/", cost: "free", type: "general", priority: 1, countries: ["AU"] },
  { key: "yellowpages-ca", name: "Yellow Pages Canada", claimUrl: "https://www.yellowpages.ca/", sourceUrl: "https://www.yellowpages.ca/", cost: "free", type: "general", priority: 1, countries: ["CA"] },
  { key: "yellowpages-us", name: "Yellow Pages (YP.com)", claimUrl: "https://www.yellowpages.com/", sourceUrl: "https://www.yellowpages.com/", cost: "free", type: "general", priority: 1, countries: ["US"] },
  { key: "yelp", name: "Yelp for Business", claimUrl: "https://business.yelp.com/", sourceUrl: "https://business.yelp.com/", cost: "free", type: "general", priority: 1, countries: ["US", "AU", "GB", "CA", "NZ"] },
  { key: "brownbook", name: "Brownbook", claimUrl: "https://www.brownbook.net/", sourceUrl: "https://www.brownbook.net/", cost: "free", type: "general", priority: 2, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "centralindex", name: "Central Index", claimUrl: "https://www.centralindex.com/", sourceUrl: "https://www.centralindex.com/", cost: "free", type: "core", priority: 2, countries: ["GB"] },
  { key: "dnb-duns", name: "Dun and Bradstreet (free D-U-N-S)", claimUrl: "https://www.dnb.com/duns/get-a-duns.html", sourceUrl: "https://www.dnb.com/duns/get-a-duns.html", cost: "free", type: "core", priority: 2, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "freeindex", name: "FreeIndex", claimUrl: "https://www.freeindex.co.uk/", sourceUrl: "https://www.freeindex.co.uk/", cost: "free", type: "general", priority: 2, countries: ["GB"] },
  { key: "hotfrog-ae", name: "Hotfrog UAE", claimUrl: "https://www.hotfrog.ae/", sourceUrl: "https://www.hotfrog.ae/", cost: "free", type: "general", priority: 2, countries: ["AE"] },
  { key: "hotfrog-au", name: "Hotfrog Australia", claimUrl: "https://www.hotfrog.com.au/", sourceUrl: "https://www.hotfrog.com.au/", cost: "free", type: "general", priority: 2, countries: ["AU"] },
  { key: "hotfrog-ca", name: "Hotfrog Canada", claimUrl: "https://www.hotfrog.ca/", sourceUrl: "https://www.hotfrog.ca/", cost: "free", type: "general", priority: 2, countries: ["CA"] },
  { key: "hotfrog-gb", name: "Hotfrog UK", claimUrl: "https://www.hotfrog.co.uk/", sourceUrl: "https://www.hotfrog.co.uk/", cost: "free", type: "general", priority: 2, countries: ["GB"] },
  { key: "hotfrog-in", name: "Hotfrog India", claimUrl: "https://www.hotfrog.in/", sourceUrl: "https://www.hotfrog.in/", cost: "free", type: "general", priority: 2, countries: ["IN"] },
  { key: "hotfrog-nz", name: "Hotfrog New Zealand", claimUrl: "https://www.hotfrog.co.nz/", sourceUrl: "https://www.hotfrog.co.nz/", cost: "free", type: "general", priority: 2, countries: ["NZ"] },
  { key: "hotfrog-us", name: "Hotfrog US", claimUrl: "https://www.hotfrog.com/", sourceUrl: "https://www.hotfrog.com/", cost: "free", type: "general", priority: 2, countries: ["US"] },
  { key: "indiamart", name: "IndiaMART", claimUrl: "https://www.indiamart.com/", sourceUrl: "https://www.indiamart.com/", cost: "free", type: "general", priority: 2, countries: ["IN"] },
  { key: "instagram-business", name: "Instagram Business Profile", claimUrl: "https://business.instagram.com/", sourceUrl: "https://business.instagram.com/", cost: "free", type: "social", priority: 2, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "linkedin-company", name: "LinkedIn Company Page", claimUrl: "https://www.linkedin.com/company/setup/new/", sourceUrl: "https://www.linkedin.com/company/setup/new/", cost: "free", type: "social", priority: 2, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "localist", name: "Localist", claimUrl: "https://www.localist.co.nz/", sourceUrl: "https://www.localist.co.nz/", cost: "free", type: "general", priority: 2, countries: ["NZ"] },
  { key: "localsearch", name: "Localsearch", claimUrl: "https://www.localsearch.com.au/", sourceUrl: "https://www.localsearch.com.au/", cost: "free", type: "general", priority: 2, countries: ["AU"] },
  { key: "manta", name: "Manta", claimUrl: "https://www.manta.com/claim", sourceUrl: "https://www.manta.com/claim", cost: "free", type: "general", priority: 2, countries: ["US"] },
  { key: "neighbourly", name: "Neighbourly", claimUrl: "https://www.neighbourly.co.nz/", sourceUrl: "https://www.neighbourly.co.nz/", cost: "free", type: "social", priority: 2, countries: ["NZ"] },
  { key: "nextdoor-business", name: "Nextdoor Business", claimUrl: "https://business.nextdoor.com/", sourceUrl: "https://business.nextdoor.com/", cost: "free", type: "social", priority: 2, countries: ["US", "GB", "CA", "AU", "NZ"] },
  { key: "startlocal", name: "Start Local", claimUrl: "https://www.startlocal.com.au/", sourceUrl: "https://www.startlocal.com.au/", cost: "free", type: "general", priority: 2, countries: ["AU"] },
  { key: "superpages", name: "Superpages", claimUrl: "https://www.superpages.com/", sourceUrl: "https://www.superpages.com/", cost: "free", type: "general", priority: 2, countries: ["US"] },
  { key: "thomsonlocal", name: "Thomson Local", claimUrl: "https://www.thomsonlocal.com/", sourceUrl: "https://www.thomsonlocal.com/", cost: "free", type: "general", priority: 2, countries: ["GB"] },
  { key: "trustpilot-business", name: "Trustpilot Business", claimUrl: "https://business.trustpilot.com/", sourceUrl: "https://business.trustpilot.com/", cost: "free", type: "general", priority: 2, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "whitepages-au", name: "White Pages Australia", claimUrl: "https://www.whitepages.com.au/", sourceUrl: "https://www.whitepages.com.au/", cost: "free", type: "general", priority: 2, countries: ["AU"] },
  { key: "192-com", name: "192.com", claimUrl: "https://www.192.com/", sourceUrl: "https://www.192.com/", cost: "free", type: "general", priority: 3, countries: ["GB"] },
  { key: "411-ca", name: "411.ca", claimUrl: "https://411.ca/", sourceUrl: "https://411.ca/", cost: "free", type: "general", priority: 3, countries: ["CA"] },
  { key: "alignable", name: "Alignable", claimUrl: "https://www.alignable.com/", sourceUrl: "https://www.alignable.com/", cost: "free", type: "social", priority: 3, countries: ["US", "CA"] },
  { key: "asklaila", name: "AskLaila", claimUrl: "https://www.asklaila.com/", sourceUrl: "https://www.asklaila.com/", cost: "free", type: "general", priority: 3, countries: ["IN"] },
  { key: "aussieweb", name: "Aussie Web", claimUrl: "https://www.aussieweb.com.au/", sourceUrl: "https://www.aussieweb.com.au/", cost: "free", type: "general", priority: 3, countries: ["AU"] },
  { key: "businesslistings-au", name: "Business Listings AU", claimUrl: "https://www.businesslistings.net.au/", sourceUrl: "https://www.businesslistings.net.au/", cost: "free", type: "general", priority: 3, countries: ["AU"] },
  { key: "canada411", name: "Canada411", claimUrl: "https://www.canada411.ca/", sourceUrl: "https://www.canada411.ca/", cost: "free", type: "general", priority: 3, countries: ["CA"] },
  { key: "chamberofcommerce-us", name: "ChamberofCommerce.com", claimUrl: "https://www.chamberofcommerce.com/", sourceUrl: "https://www.chamberofcommerce.com/", cost: "free", type: "general", priority: 3, countries: ["US"] },
  { key: "cybo", name: "Cybo", claimUrl: "https://cybo.com/", sourceUrl: "https://cybo.com/", cost: "free", type: "general", priority: 3, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "cylex-ca", name: "Cylex Canada", claimUrl: "https://www.cylex-canada.ca/", sourceUrl: "https://www.cylex-canada.ca/", cost: "free", type: "general", priority: 3, countries: ["CA"] },
  { key: "cylex-gb", name: "Cylex UK", claimUrl: "https://www.cylex-uk.co.uk/", sourceUrl: "https://www.cylex-uk.co.uk/", cost: "free", type: "general", priority: 3, countries: ["GB"] },
  { key: "cylex-nz", name: "Cylex New Zealand", claimUrl: "https://www.cylex.co.nz/", sourceUrl: "https://www.cylex.co.nz/", cost: "free", type: "general", priority: 3, countries: ["NZ"] },
  { key: "cylex-us", name: "Cylex USA", claimUrl: "https://www.cylex.us.com/", sourceUrl: "https://www.cylex.us.com/", cost: "free", type: "general", priority: 3, countries: ["US"] },
  { key: "dubizzle", name: "Dubizzle", claimUrl: "https://dubai.dubizzle.com/", sourceUrl: "https://dubai.dubizzle.com/", cost: "free", type: "general", priority: 3, countries: ["AE"] },
  { key: "expatwoman", name: "ExpatWoman Directory", claimUrl: "https://www.expatwoman.com/", sourceUrl: "https://www.expatwoman.com/", cost: "free", type: "general", priority: 3, countries: ["AE"] },
  { key: "exportersindia", name: "ExportersIndia", claimUrl: "https://www.exportersindia.com/", sourceUrl: "https://www.exportersindia.com/", cost: "free", type: "general", priority: 3, countries: ["IN"] },
  { key: "ezlocal", name: "ezlocal", claimUrl: "https://ezlocal.com/", sourceUrl: "https://ezlocal.com/", cost: "free", type: "general", priority: 3, countries: ["US"] },
  { key: "grotal", name: "Grotal", claimUrl: "https://www.grotal.com/", sourceUrl: "https://www.grotal.com/", cost: "free", type: "general", priority: 3, countries: ["IN"] },
  { key: "infobel", name: "Infobel", claimUrl: "https://www.infobel.com/", sourceUrl: "https://www.infobel.com/", cost: "free", type: "core", priority: 3, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "insiderpages", name: "Insider Pages", claimUrl: "https://www.insiderpages.com/", sourceUrl: "https://www.insiderpages.com/", cost: "free", type: "general", priority: 3, countries: ["US"] },
  { key: "kompass", name: "Kompass", claimUrl: "https://www.kompass.com/", sourceUrl: "https://www.kompass.com/", cost: "free", type: "general", priority: 3, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "localbusinessguide-au", name: "Local Business Guide AU", claimUrl: "https://www.localbusinessguide.com.au/", sourceUrl: "https://www.localbusinessguide.com.au/", cost: "free", type: "general", priority: 3, countries: ["AU"] },
  { key: "mapquest", name: "MapQuest", claimUrl: "https://www.mapquest.com/", sourceUrl: "https://www.mapquest.com/", cost: "free", type: "maps", priority: 3, countries: ["US"] },
  { key: "merchantcircle", name: "MerchantCircle", claimUrl: "https://www.merchantcircle.com/", sourceUrl: "https://www.merchantcircle.com/", cost: "free", type: "general", priority: 3, countries: ["US"] },
  { key: "misterwhat-gb", name: "Mister What UK", claimUrl: "https://www.misterwhat.co.uk/", sourceUrl: "https://www.misterwhat.co.uk/", cost: "free", type: "general", priority: 3, countries: ["GB"] },
  { key: "n49", name: "N49", claimUrl: "https://www.n49.com/", sourceUrl: "https://www.n49.com/", cost: "free", type: "general", priority: 3, countries: ["CA"] },
  { key: "nzdirectory", name: "NZ Business Directory", claimUrl: "https://www.nzdirectory.co.nz/", sourceUrl: "https://www.nzdirectory.co.nz/", cost: "free", type: "general", priority: 3, countries: ["NZ"] },
  { key: "opendi-ca", name: "Opendi Canada", claimUrl: "https://www.opendi.ca/", sourceUrl: "https://www.opendi.ca/", cost: "free", type: "general", priority: 3, countries: ["CA"] },
  { key: "opendi-gb", name: "Opendi UK", claimUrl: "https://www.opendi.co.uk/", sourceUrl: "https://www.opendi.co.uk/", cost: "free", type: "general", priority: 3, countries: ["GB"] },
  { key: "opendi-us", name: "Opendi US", claimUrl: "https://www.opendi.us/", sourceUrl: "https://www.opendi.us/", cost: "free", type: "general", priority: 3, countries: ["US"] },
  { key: "openstreetmap", name: "OpenStreetMap", claimUrl: "https://www.openstreetmap.org/", sourceUrl: "https://www.openstreetmap.org/", cost: "free", type: "maps", priority: 3, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "pinterest-business", name: "Pinterest Business Account", claimUrl: "https://business.pinterest.com/", sourceUrl: "https://business.pinterest.com/", cost: "free", type: "social", priority: 3, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "productreview-au", name: "ProductReview Australia", claimUrl: "https://www.productreview.com.au/", sourceUrl: "https://www.productreview.com.au/", cost: "free", type: "general", priority: 3, countries: ["AU"] },
  { key: "quikr", name: "Quikr", claimUrl: "https://www.quikr.com/", sourceUrl: "https://www.quikr.com/", cost: "free", type: "general", priority: 3, countries: ["IN"] },
  { key: "scoot", name: "Scoot", claimUrl: "https://www.scoot.co.uk/", sourceUrl: "https://www.scoot.co.uk/", cost: "free", type: "general", priority: 3, countries: ["GB"] },
  { key: "touchlocal", name: "Touch Local", claimUrl: "https://www.touchlocal.com/", sourceUrl: "https://www.touchlocal.com/", cost: "free", type: "general", priority: 3, countries: ["GB"] },
  { key: "tradeindia", name: "TradeIndia", claimUrl: "https://www.tradeindia.com/", sourceUrl: "https://www.tradeindia.com/", cost: "free", type: "general", priority: 3, countries: ["IN"] },
  { key: "uaebusinessdirectory", name: "UAE Business Directory", claimUrl: "https://www.uaebusinessdirectory.com/", sourceUrl: "https://www.uaebusinessdirectory.com/", cost: "free", type: "general", priority: 3, countries: ["AE"] },
  { key: "uksmallbusinessdirectory", name: "UK Small Business Directory", claimUrl: "https://www.uksmallbusinessdirectory.co.uk/", sourceUrl: "https://www.uksmallbusinessdirectory.co.uk/", cost: "free", type: "general", priority: 3, countries: ["GB"] },
  { key: "whatsapp-business", name: "WhatsApp Business", claimUrl: "https://business.whatsapp.com/", sourceUrl: "https://business.whatsapp.com/", cost: "free", type: "social", priority: 3, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "whereis", name: "Whereis", claimUrl: "https://www.whereis.com/", sourceUrl: "https://www.whereis.com/", cost: "free", type: "maps", priority: 3, countries: ["AU"] },
  { key: "whitepages-nz", name: "White Pages New Zealand", claimUrl: "https://www.whitepages.co.nz/", sourceUrl: "https://www.whitepages.co.nz/", cost: "free", type: "general", priority: 3, countries: ["NZ"] },
  { key: "yalla", name: "Yalla", claimUrl: "https://www.yalla.com/", sourceUrl: "https://www.yalla.com/", cost: "free", type: "general", priority: 3, countries: ["AE"] },
  { key: "youtube-channel", name: "YouTube Channel", claimUrl: "https://www.youtube.com/create_channel", sourceUrl: "https://www.youtube.com/create_channel", cost: "free", type: "social", priority: 3, countries: ["IN", "US", "AU", "GB", "CA", "NZ", "AE"] },
  { key: "zawya", name: "Zawya", claimUrl: "https://www.zawya.com/", sourceUrl: "https://www.zawya.com/", cost: "free", type: "general", priority: 3, countries: ["AE"] },];

/** The countries that have a list: the ones in dfs-locations.ts. */
export const CITATION_COUNTRIES = Object.keys(DFS_COUNTRY_LOCATIONS.codes);

/** The country whose list is used for an ISO code (case-insensitive); the fallback region when unknown. */
export function citationCountryFor(regionCode: string | null | undefined): string {
  const c = regionCode?.trim().toUpperCase();
  return c && CITATION_COUNTRIES.includes(c) ? c : DFS_COUNTRY_LOCATIONS.fallbackRegion;
}

/** The sites for a country, most important first. */
export function citationSitesFor(regionCode: string | null | undefined): CitationSite[] {
  const country = citationCountryFor(regionCode);
  return CITATION_SITES.filter((s) => s.countries.includes(country)).sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );
}

export const citationSiteByKey = (key: string): CitationSite | undefined => CITATION_SITES.find((s) => s.key === key);
