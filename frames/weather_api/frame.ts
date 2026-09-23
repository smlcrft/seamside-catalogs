// ----------------------------------------------------------------------------------------
// This frame is a weather info/forecast app using the open-meteo keyless API.
// Location is supplied per-request; the fields and units are the ones the page draws.
// ----------------------------------------------------------------------------------------
import { log, serveFileAtPath } from "@frame-core"; // must include @frame-core for tandem frame.

// ----------------------------------------------------------------------------------------
// WEATHER FETCH + PER-LOCATION 5-MINUTE CACHE
// ----------------------------------------------------------------------------------------
type WeatherData = { location: { name: string; country: string; latitude: number; longitude: number }; [key: string]: unknown };
const weatherCache = new Map<string, { data: WeatherData; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchWeather(locationQuery: string): Promise<WeatherData> {
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
  log(`Weather fetched for ${displayName}`);
  return data;
}

// ----------------------------------------------------------------------------------------
// NETWORKING: Handle incoming requests and respond accordingly.
// ----------------------------------------------------------------------------------------
self.onNetworkRequest = async function (replyPort, reqPath, method, _headers, query, _body, _cookies) {
  // /api/weather?location=<city> — returns JSON with current conditions + forecast.
  if (reqPath === "/api/weather" && method === "GET") {
    const locationQuery = (query.location ?? "").trim();
    if (!locationQuery) {
      replyPort.postMessage({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Missing ?location= parameter" }) });
      return;
    }
    try {
      const data = await fetchWeather(locationQuery);
      replyPort.postMessage({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // An unknown place is the asker's miss (404); anything else is open-meteo's (502).
      const status = (e as { status?: number })?.status ?? 502;
      if (status !== 404) log("fetchWeather error: " + msg);
      replyPort.postMessage({ status, contentType: "application/json", body: JSON.stringify({ error: msg }) });
    }
    return;
  }
  // Serve static files from ./public/ — use path only, never the query string.
  if (method === "GET") {
    const filePath = new URL("./public" + reqPath, import.meta.url);
    serveFileAtPath(replyPort, filePath);
    return;
  }
  replyPort.postMessage({ status: 404, body: JSON.stringify({ error: "Request not handled.", code: "NOT_FOUND" }), contentType: "application/json" });
};

// ----------------------------------------------------------------------------------------
log("Frame is up and running!");
