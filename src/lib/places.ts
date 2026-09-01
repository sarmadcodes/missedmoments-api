import { request } from 'undici';
import { config } from '../config.js';
import { queryOne, query } from './db.js';

/**
 * Resolves a coordinate to a human venue name ("Blue Door Cafe") using the
 * Google Places API.
 *
 * The API key lives here, server-side, and is never shipped in the app. Results
 * are cached in the `places` table and looked up spatially first, so repeat
 * check-ins at the same venue cost nothing.
 */

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';

// If a cached place is within this distance, reuse it instead of calling out.
const CACHE_HIT_RADIUS_M = 60;
// How far to look for a named venue around the user.
const SEARCH_RADIUS_M = 80;

export type ResolvedPlace = {
  placeId: string | null;
  placeName: string | null;
};

type PlacesResponse = {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
};

const fromCache = async (lat: number, lng: number): Promise<ResolvedPlace | null> => {
  const row = await queryOne<{ place_id: string; name: string }>(
    `SELECT place_id, name
       FROM places
      WHERE ST_DWithin(location, ST_MakePoint($2, $1)::geography, $3)
      ORDER BY location <-> ST_MakePoint($2, $1)::geography
      LIMIT 1`,
    [lat, lng, CACHE_HIT_RADIUS_M],
  );

  return row ? { placeId: row.place_id, placeName: row.name } : null;
};

export const resolvePlace = async (
  lat: number,
  lng: number,
): Promise<ResolvedPlace> => {
  const cached = await fromCache(lat, lng);
  if (cached) return cached;

  // Without a key configured the app still works; moments are just unnamed.
  if (!config.GOOGLE_MAPS_API_KEY) {
    return { placeId: null, placeName: null };
  }

  try {
    const res = await request(PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.GOOGLE_MAPS_API_KEY,
        // Field mask is required by Places v1 and keeps the call in the
        // cheapest billing tier.
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({
        maxResultCount: 1,
        rankPreference: 'DISTANCE',
        // Venues people actually meet at, rather than every rooftop and road.
        includedTypes: [
          'cafe',
          'restaurant',
          'bar',
          'bakery',
          'book_store',
          'train_station',
          'subway_station',
          'transit_station',
          'park',
          'gym',
          'library',
        ],
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: SEARCH_RADIUS_M,
          },
        },
      }),
      headersTimeout: 4000,
      bodyTimeout: 4000,
    });

    if (res.statusCode !== 200) {
      return { placeId: null, placeName: null };
    }

    const body = (await res.body.json()) as PlacesResponse;
    const place = body.places?.[0];
    const placeId = place?.id ?? null;
    const placeName = place?.displayName?.text ?? null;

    if (placeId && placeName && place?.location) {
      await query(
        `INSERT INTO places (place_id, name, location, address)
         VALUES ($1, $2, ST_MakePoint($4, $3)::geography, $5)
         ON CONFLICT (place_id) DO UPDATE
           SET name = EXCLUDED.name, fetched_at = now()`,
        [
          placeId,
          placeName,
          place.location.latitude,
          place.location.longitude,
          place.formattedAddress ?? null,
        ],
      );
    }

    return { placeId, placeName };
  } catch {
    // A Places outage must never block a check-in.
    return { placeId: null, placeName: null };
  }
};
