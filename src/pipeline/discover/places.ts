import { db } from "@/lib/supabase";
import { SourcedPartner } from "./sources";

// Google Places (New) Text Search — the volume source. Text Search caps at ~60
// results per query, so a state-level query ("pet crematory in California")
// only ever returns the top ~60 and the rest are invisible. We therefore sweep
// at CITY/METRO granularity (each "{q} in {City, ST}" returns up to 60 LOCAL
// results), which multiplies the reachable surface ~10x+. States are kept as a
// trailing backstop for rural listings. Resumable via a cursor in ph_config.
// Cost note: Pro-tier field mask (~$0.032/request), no reviews fields.

// ~190 metros spanning every state, population-weighted. City granularity is
// where the long tail of pet crematories / cemeteries / aftercare lives.
const CITIES = [
  // CA
  "Los Angeles, CA","San Diego, CA","San Jose, CA","San Francisco, CA","Fresno, CA","Sacramento, CA","Long Beach, CA","Oakland, CA","Bakersfield, CA","Riverside, CA","Santa Ana, CA","Anaheim, CA","Stockton, CA","Irvine, CA","Chula Vista, CA","Fremont, CA","Santa Rosa, CA","Modesto, CA",
  // TX
  "Houston, TX","San Antonio, TX","Dallas, TX","Austin, TX","Fort Worth, TX","El Paso, TX","Arlington, TX","Corpus Christi, TX","Plano, TX","Lubbock, TX","Laredo, TX","Garland, TX","Amarillo, TX","McAllen, TX",
  // FL
  "Jacksonville, FL","Miami, FL","Tampa, FL","Orlando, FL","St. Petersburg, FL","Hialeah, FL","Tallahassee, FL","Fort Lauderdale, FL","Cape Coral, FL","Pensacola, FL","Sarasota, FL","Naples, FL",
  // NY
  "New York, NY","Buffalo, NY","Rochester, NY","Yonkers, NY","Syracuse, NY","Albany, NY",
  // IL / midwest
  "Chicago, IL","Aurora, IL","Naperville, IL","Springfield, IL","Peoria, IL","Rockford, IL",
  // PA
  "Philadelphia, PA","Pittsburgh, PA","Allentown, PA","Erie, PA","Scranton, PA","Harrisburg, PA",
  // OH
  "Columbus, OH","Cleveland, OH","Cincinnati, OH","Toledo, OH","Akron, OH","Dayton, OH",
  // GA
  "Atlanta, GA","Augusta, GA","Columbus, GA","Savannah, GA","Athens, GA","Macon, GA",
  // NC
  "Charlotte, NC","Raleigh, NC","Greensboro, NC","Durham, NC","Winston-Salem, NC","Fayetteville, NC","Wilmington, NC","Asheville, NC",
  // MI
  "Detroit, MI","Grand Rapids, MI","Ann Arbor, MI","Lansing, MI","Flint, MI","Kalamazoo, MI",
  // NJ
  "Newark, NJ","Jersey City, NJ","Trenton, NJ","Edison, NJ","Toms River, NJ",
  // VA
  "Virginia Beach, VA","Richmond, VA","Norfolk, VA","Chesapeake, VA","Arlington, VA","Roanoke, VA",
  // WA
  "Seattle, WA","Spokane, WA","Tacoma, WA","Vancouver, WA","Bellevue, WA","Olympia, WA",
  // AZ
  "Phoenix, AZ","Tucson, AZ","Mesa, AZ","Chandler, AZ","Scottsdale, AZ","Gilbert, AZ","Flagstaff, AZ",
  // MA
  "Boston, MA","Worcester, MA","Springfield, MA","Cambridge, MA","Lowell, MA",
  // TN
  "Nashville, TN","Memphis, TN","Knoxville, TN","Chattanooga, TN","Clarksville, TN",
  // IN
  "Indianapolis, IN","Fort Wayne, IN","Evansville, IN","South Bend, IN","Bloomington, IN",
  // MO
  "Kansas City, MO","St. Louis, MO","Springfield, MO","Columbia, MO","Joplin, MO",
  // MD
  "Baltimore, MD","Frederick, MD","Rockville, MD","Annapolis, MD",
  // WI
  "Milwaukee, WI","Madison, WI","Green Bay, WI","Kenosha, WI",
  // CO
  "Denver, CO","Colorado Springs, CO","Aurora, CO","Fort Collins, CO","Boulder, CO","Pueblo, CO",
  // MN
  "Minneapolis, MN","St. Paul, MN","Rochester, MN","Duluth, MN",
  // SC
  "Columbia, SC","Charleston, SC","Greenville, SC","Myrtle Beach, SC",
  // AL
  "Birmingham, AL","Montgomery, AL","Mobile, AL","Huntsville, AL",
  // LA
  "New Orleans, LA","Baton Rouge, LA","Shreveport, LA","Lafayette, LA",
  // KY
  "Louisville, KY","Lexington, KY","Bowling Green, KY",
  // OR
  "Portland, OR","Eugene, OR","Salem, OR","Bend, OR",
  // OK
  "Oklahoma City, OK","Tulsa, OK","Norman, OK",
  // CT
  "Bridgeport, CT","New Haven, CT","Hartford, CT","Stamford, CT",
  // UT
  "Salt Lake City, UT","Provo, UT","Ogden, UT","St. George, UT",
  // IA
  "Des Moines, IA","Cedar Rapids, IA","Davenport, IA",
  // NV
  "Las Vegas, NV","Reno, NV","Henderson, NV",
  // AR
  "Little Rock, AR","Fayetteville, AR","Fort Smith, AR",
  // MS
  "Jackson, MS","Gulfport, MS","Hattiesburg, MS",
  // KS
  "Wichita, KS","Kansas City, KS","Topeka, KS","Overland Park, KS",
  // NM
  "Albuquerque, NM","Las Cruces, NM","Santa Fe, NM",
  // NE
  "Omaha, NE","Lincoln, NE",
  // ID
  "Boise, ID","Idaho Falls, ID","Coeur d'Alene, ID",
  // WV
  "Charleston, WV","Huntington, WV","Morgantown, WV",
  // NH
  "Manchester, NH","Nashua, NH","Concord, NH",
  // ME
  "Portland, ME","Bangor, ME",
  // RI
  "Providence, RI","Warwick, RI",
  // MT
  "Billings, MT","Missoula, MT","Bozeman, MT",
  // DE
  "Wilmington, DE","Dover, DE",
  // SD
  "Sioux Falls, SD","Rapid City, SD",
  // ND
  "Fargo, ND","Bismarck, ND",
  // AK
  "Anchorage, AK","Fairbanks, AK",
  // VT
  "Burlington, VT",
  // WY
  "Cheyenne, WY","Casper, WY",
  // HI
  "Honolulu, HI","Hilo, HI",
  // DC
  "Washington, DC",
];

const STATES = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
  "Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky",
  "Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi",
  "Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico",
  "New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
  "Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont",
  "Virginia","Washington","West Virginia","Wisconsin","Wyoming",
];

// Cities first (the new long-tail ground), states as a trailing rural backstop.
const LOCATIONS = [...CITIES, ...STATES];
export const PLACES_LOCATION_COUNT = LOCATIONS.length;

interface PlacesCampaign {
  cursorKey: string;
  segment: "memorial" | "vet";
  queries: { q: string; subtype: string }[];
}

const MEMORIAL: PlacesCampaign = {
  cursorKey: "_places_cursor",
  segment: "memorial",
  queries: [
    { q: "pet crematory", subtype: "crematory" },
    { q: "pet cremation service", subtype: "crematory" },
    { q: "pet cemetery", subtype: "cemetery" },
    { q: "pet aquamation", subtype: "crematory" },
    { q: "animal cremation", subtype: "crematory" },
    { q: "dog cremation", subtype: "crematory" },
    { q: "pet funeral home", subtype: "crematory" },
    { q: "pet memorial service", subtype: "memorial" },
    { q: "in-home pet euthanasia", subtype: "in-home-euthanasia" },
    { q: "pet aftercare service", subtype: "aftercare" },
  ],
};

// Vet segment — broadened query set so the segment actually grows (it was stuck
// at ~65). Intent-loaded so Google surfaces aftercare-doing clinics, not all
// practices; enrich then confirms each offers euthanasia/hospice/aftercare.
const VET: PlacesCampaign = {
  cursorKey: "_places_vet_cursor",
  segment: "vet",
  queries: [
    { q: "pet euthanasia veterinarian", subtype: "euthanasia" },
    { q: "at home pet euthanasia", subtype: "mobile-euthanasia" },
    { q: "mobile vet euthanasia", subtype: "mobile-euthanasia" },
    { q: "veterinary hospice care", subtype: "hospice" },
    { q: "pet hospice", subtype: "hospice" },
    { q: "veterinarian pet cremation services", subtype: "vet-aftercare" },
    { q: "compassionate end of life veterinarian", subtype: "end-of-life" },
    { q: "animal hospital euthanasia", subtype: "euthanasia" },
  ],
};

// (location, query) combos processed per run — configurable via ph_config
// (places_combos_per_run) so discovery speed/cost is a dial.
const DEFAULT_COMBOS_PER_RUN = 12;

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.addressComponents",
  "nextPageToken",
].join(",");

interface Place {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
}

async function searchText(
  apiKey: string,
  textQuery: string,
  pageToken?: string
): Promise<{ places: Place[]; nextPageToken?: string }> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(pageToken ? { pageToken } : { textQuery, pageSize: 20 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Places searchText → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as { places?: Place[]; nextPageToken?: string } as {
    places: Place[];
    nextPageToken?: string;
  };
}

function component(p: Place, type: string): string | undefined {
  return p.addressComponents?.find((c) => c.types?.includes(type))?.shortText ?? undefined;
}

async function getCursor(key: string): Promise<{ locIdx: number; queryIdx: number; done: boolean }> {
  const { data } = await db().from("ph_config").select("value").eq("key", key).maybeSingle();
  if (!data?.value) return { locIdx: 0, queryIdx: 0, done: false };
  try {
    const c = JSON.parse(data.value);
    // Tolerate the old {stateIdx,...} schema — restart cleanly at 0.
    return { locIdx: Number(c.locIdx ?? 0) || 0, queryIdx: Number(c.queryIdx ?? 0) || 0, done: !!c.done };
  } catch {
    return { locIdx: 0, queryIdx: 0, done: false };
  }
}

async function setCursor(
  key: string,
  cursor: { locIdx: number; queryIdx: number; done: boolean }
): Promise<void> {
  await db().from("ph_config").upsert({
    key,
    value: JSON.stringify(cursor),
    updated_at: new Date().toISOString(),
  });
}

async function combosPerRun(): Promise<number> {
  const { data } = await db().from("ph_config").select("value").eq("key", "places_combos_per_run").maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMBOS_PER_RUN;
}

async function sweepPlaces(campaign: PlacesCampaign): Promise<SourcedPartner[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn("places: GOOGLE_PLACES_API_KEY not set — skipping");
    return [];
  }

  const { setProgress } = await import("@/lib/progress");
  const { queries, segment, cursorKey } = campaign;
  const out: SourcedPartner[] = [];
  let cursor = await getCursor(cursorKey);
  if (cursor.done) {
    console.log(`places(${segment}): full sweep complete`);
    return out;
  }

  const perRun = await combosPerRun();
  for (let combo = 0; combo < perRun; combo++) {
    if (cursor.done) break;
    const location = LOCATIONS[cursor.locIdx];
    const { q, subtype } = queries[cursor.queryIdx];
    const textQuery = `${q} in ${location}`;
    await setProgress(
      `discover places(${segment}): "${textQuery}" (loc ${cursor.locIdx + 1}/${LOCATIONS.length}), ${out.length} found so far`
    );

    try {
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const r = await searchText(apiKey, textQuery, pageToken);
        for (const p of r.places ?? []) {
          if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
          const name = p.displayName?.text;
          if (!name) continue;
          out.push({
            business_name: name,
            city: component(p, "locality"),
            state: component(p, "administrative_area_level_1"),
            phone: p.nationalPhoneNumber,
            website: p.websiteUri,
            source: `places:${p.id}`,
            segment,
            subtype,
            is_chain: false,
            rating: p.rating,
            reviews_count: p.userRatingCount,
          });
        }
        pageToken = r.nextPageToken;
        pages++;
      } while (pageToken && pages < 3);
    } catch (e) {
      console.error(`places(${segment}): "${textQuery}" failed: ${(e as Error).message}`);
    }

    // Advance: queries within a location, then next location.
    cursor =
      cursor.queryIdx + 1 < queries.length
        ? { ...cursor, queryIdx: cursor.queryIdx + 1 }
        : cursor.locIdx + 1 < LOCATIONS.length
          ? { locIdx: cursor.locIdx + 1, queryIdx: 0, done: false }
          : { locIdx: 0, queryIdx: 0, done: true };
  }

  await setCursor(cursorKey, cursor);
  return out;
}

export const discoverPlaces = () => sweepPlaces(MEMORIAL);
export const discoverPlacesVet = () => sweepPlaces(VET);
