import { db } from "@/lib/supabase";
import { SourcedPartner } from "./sources";

// Google Places (New) Text Search — the volume source for the memorial
// segment. State-by-state category sweeps, resumable via a cursor in
// ph_config so each hourly autopilot slice covers a bounded chunk.
// Cost note: Pro-tier field mask (~$0.032/request), no reviews fields.

const STATES = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
  "Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky",
  "Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi",
  "Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico",
  "New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
  "Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont",
  "Virginia","Washington","West Virginia","Wisconsin","Wyoming",
];

interface PlacesCampaign {
  cursorKey: string;
  segment: "memorial" | "vet";
  queries: { q: string; subtype: string }[];
}

// Memorial segment — businesses whose whole purpose is the memorial moment.
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

// Vet segment — clinics at the end-of-life moment. Intent-loaded queries so
// Google's own ranking surfaces aftercare-doing vets, not all 28k practices;
// enrich then confirms each actually offers euthanasia/hospice/aftercare.
const VET: PlacesCampaign = {
  cursorKey: "_places_vet_cursor",
  segment: "vet",
  queries: [
    { q: "pet euthanasia veterinarian", subtype: "euthanasia" },
    { q: "veterinary hospice care", subtype: "hospice" },
    { q: "mobile pet euthanasia veterinarian", subtype: "mobile-euthanasia" },
    { q: "veterinarian pet cremation services", subtype: "vet-aftercare" },
    { q: "compassionate end of life veterinarian", subtype: "end-of-life" },
  ],
};

// (state, query) combos processed per run. 3 combos ≈ one state per run →
// full US sweep in ~50 autopilot cycles (~2 days), ~$1-2/day in API fees.
const COMBOS_PER_RUN = 3;

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

async function getCursor(key: string): Promise<{ stateIdx: number; queryIdx: number; done: boolean }> {
  const { data } = await db().from("ph_config").select("value").eq("key", key).maybeSingle();
  if (!data?.value) return { stateIdx: 0, queryIdx: 0, done: false };
  try {
    return JSON.parse(data.value);
  } catch {
    return { stateIdx: 0, queryIdx: 0, done: false };
  }
}

async function setCursor(
  key: string,
  cursor: { stateIdx: number; queryIdx: number; done: boolean }
): Promise<void> {
  await db().from("ph_config").upsert({
    key,
    value: JSON.stringify(cursor),
    updated_at: new Date().toISOString(),
  });
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
    console.log(`places(${segment}): full US sweep complete`);
    return out;
  }

  for (let combo = 0; combo < COMBOS_PER_RUN; combo++) {
    if (cursor.done) break;
    const state = STATES[cursor.stateIdx];
    const { q, subtype } = queries[cursor.queryIdx];
    const textQuery = `${q} in ${state}`;
    await setProgress(
      `discover places(${segment}): "${textQuery}" (state ${cursor.stateIdx + 1}/${STATES.length}), ${out.length} found so far`
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

    // Advance: queries within a state, then next state.
    cursor =
      cursor.queryIdx + 1 < queries.length
        ? { ...cursor, queryIdx: cursor.queryIdx + 1 }
        : cursor.stateIdx + 1 < STATES.length
          ? { stateIdx: cursor.stateIdx + 1, queryIdx: 0, done: false }
          : { stateIdx: 0, queryIdx: 0, done: true };
  }

  await setCursor(cursorKey, cursor);
  return out;
}

export const discoverPlaces = () => sweepPlaces(MEMORIAL);
export const discoverPlacesVet = () => sweepPlaces(VET);
