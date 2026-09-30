// ----------------------------------------------------------------------------------------
// This frame is a weather info/forecast app using the open-meteo keyless API.
// Location is supplied per-request; the fields and units are the ones the page draws.
// Anyone who reaches the frame may look a place up; nothing is written to the space.
// ----------------------------------------------------------------------------------------
import type { Ctx } from "@frame-core";

// ----------------------------------------------------------------------------------------
// WEATHER FETCH + PER-LOCATION 5-MINUTE CACHE
// ----------------------------------------------------------------------------------------
type WeatherData = { location: { name: string; country: string; latitude: number; longitude: number }; [key: string]: unknown };
const weatherCache = new Map<string, { data: WeatherData; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchWeather(ctx: Ctx, locationQuery: string): Promise<WeatherData> {
  const cacheKey = locationQuery.trim().toLowerCase();
  const now = Date.now();
  const cached = weatherCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  // Step 1: Geocode the city name to lat/lon.
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationQuery)}&count=1&language=en&format=json`;
  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) throw new Error(`Geocoding request failed: ${geoRes.status}`);
  const geoJson = await geoRes.json();
  const loc = geoJson.results?.[0];
  if (!loc) throw Object.assign(new Error(`Location not found: "${locationQuery}"`), { status: 404 });
  const { latitude, longitude, name, country, admin1 } = loc;
  // Step 2: Fetch weather: every field the page renders, in the units it labels.
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current:            "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
    daily:              "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
    temperature_unit:   "fahrenheit",
    wind_speed_unit:    "mph",
    precipitation_unit: "inch",
    timezone:           "auto",
    forecast_days:      "5",
  });
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?${params}`;
  const weatherRes = await fetch(weatherUrl);
  if (!weatherRes.ok) throw new Error(`Weather request failed: ${weatherRes.status}`);
  const weatherJson = await weatherRes.json();
  const displayName = admin1 ? `${name}, ${admin1}` : `${name}, ${country}`;
  const data: WeatherData = { location: { name: displayName, country, latitude, longitude }, ...weatherJson };
  weatherCache.set(cacheKey, { data, fetchedAt: now });
  ctx.log(`Weather fetched for ${displayName}`);
  return data;
}

const json = (v: unknown, status = 200) => Response.json(v, { status });

// ----------------------------------------------------------------------------------------
// NETWORKING: Handle incoming requests and respond accordingly.
// ----------------------------------------------------------------------------------------
export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    // /api/weather?location=<city> — returns JSON with current conditions + forecast.
    if (url.pathname === "/api/weather" && request.method === "GET") {
      const locationQuery = (url.searchParams.get("location") ?? "").trim();
      if (!locationQuery) return json({ error: "Missing ?location= parameter" }, 400);
      try {
        return json(await fetchWeather(ctx, locationQuery));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // An unknown place is the asker's miss (404); anything else is open-meteo's (502).
        const status = (e as { status?: number })?.status ?? 502;
        if (status !== 404) ctx.log("fetchWeather error: " + msg);
        return json({ error: msg }, status);
      }
    }
    // Static files from ./public/, by path only, never the query string.
    if (request.method === "GET") return ctx.file(url.pathname);
    return json({ error: "Request not handled.", code: "NOT_FOUND" }, 404);
  },
};
