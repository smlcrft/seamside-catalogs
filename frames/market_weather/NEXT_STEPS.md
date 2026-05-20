# Market Weather — next steps

Ideas worth chasing once the v1 lands in vendors' hands and we get feedback:

- **Per-market profile.** A "what kind of place is this" picker (farmers market, food
  truck, festival, walkable storefront, brewery patio). Each profile would shift the
  factor weights — a beer garden's turnout barely cares about hour-of-day and adores
  warm evenings; a 7am farmers market lives or dies by Saturday morning rain.

- **Real climate normals.** Right now "seasonal pleasantness" compares the forecast
  to a 30-day rolling local mean. That works for "warm break in a cold week" but
  doesn't know that 75°F in December is genuinely remarkable somewhere it normally
  freezes. Pull Open-Meteo's `climate` endpoint or ERA5 archive for a true
  long-term-average baseline and the seasonal factor gets a lot smarter.

- **Vendor "tip line".** A small free-text journal where vendors can record actual
  turnout vs. predicted ("Sat felt like 80%, predicted 65 — bring more eggs next
  cool morning"). Over enough Saturdays, that history could re-tune the weights
  per-placement.

- **Multi-day comparison.** Side-by-side bar of "expected total turnout" per day
  for the next 7 days, to support the question "should I do Saturday OR Sunday
  this weekend?" not just "what does Saturday look like?"

- **Push to a shared SyncTable** so a multi-vendor market can subscribe one shared
  forecast and overlay each booth's own attendance log on top — the current frame
  is per-placement-prefs only, which means each booth has to enter the location
  again. Worth doing once we have more than one or two vendors per market actually
  using it.

- **Severe-weather alarms.** A real "DON'T BOTHER OPENING" flag for sustained
  rain >0.25 in/hr, sustained wind >30 mph, lightning probability, etc. Right now
  those just sink the turnout curve to ~10%; surfacing them as a chip would let a
  vendor see the call before they read the chart.
