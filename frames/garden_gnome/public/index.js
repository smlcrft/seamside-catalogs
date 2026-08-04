import { frame } from "/lib/js/framelib.js";

(function () {
  const peer = window.__peer || {};
  const isAnon = !!peer.is_anon || !peer.user_id;

  const $ = (id) => document.getElementById(id);

  // ----- Anonymous gate ------------------------------------------------------------------
  if (isAnon) {
    document.body.innerHTML =
      '<div class="note"><i class="ph-light ph-lock-simple icon-sm"></i> ' +
      'Garden Gnome is a private frame. Sign in to view this garden.</div>';
    return;
  }

  // ----- State ---------------------------------------------------------------------------
  let state = {
    prefs: { location: "", soil: "loamy", plants: [] },
    soil_types: [],
    plant_types: [],
    weather: null,
    statuses: [],
    has_location: false,
    can_edit: false,
    is_owner: false,
  };
  // working copy used while the settings dialog is open
  let draft = null;

  // ----- Helpers -------------------------------------------------------------------------
  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function describeScore(channel, score, value) {
    let word;
    if (score < -1.5) word = "very under";
    else if (score < -1) word = "well under";
    else if (score < -0.5) word = "below center";
    else if (score <= 0.5) word = "in the sweet spot";
    else if (score <= 1) word = "above center";
    else if (score <= 1.5) word = "well over";
    else word = "very over";
    const label =
      channel === "water" ? `Water: ${word} (${value.toFixed(2)}" in soil)` :
      channel === "temp"  ? `Temperature: ${word} (${value.toFixed(1)}°F weighted)` :
                            `Sunlight: ${word} (UV ${value.toFixed(1)} weighted)`;
    return label;
  }

  // Risk badges map to a small accent palette + a phosphor icon. The pieces are kept
  // in JS so we can derive the chip class from the risk key without a CSS dictionary.
  const RISK_STYLES = {
    "FREEZE RISK":  { tone: "cold",    icon: "ph-snowflake" },
    "HEAT STRESS":  { tone: "hot",     icon: "ph-fire" },
    "DROUGHT RISK": { tone: "dry",     icon: "ph-drop-half" },
    "WATERLOGGED":  { tone: "soaked",  icon: "ph-cloud-rain" },
  };

  // ----- Render --------------------------------------------------------------------------
  // The frame's one reading: compose the day's verdict from the weather + the
  // plants' computed risks, spoken as a sentence on the ink plate.
  function renderReading() {
    const plate = $("reading");
    if (!state.weather) { plate.classList.add("hidden"); return; }
    const w = state.weather.summary;
    const name = state.weather.resolved_name;
    const now = Math.round(w.current_temp_f);
    const lo  = Math.round(w.forecast_24h_min_temp);
    const hi  = Math.round(w.forecast_24h_max_temp);
    const rainAhead = w.forecast_24h_rain;
    const rainStr = rainAhead.toFixed(rainAhead >= 1 ? 1 : 2);
    const risks = state.statuses.flatMap((s) => s.risks || []);
    const dry = risks.some((r) => /DROUGHT|DRY/i.test(r.key || ""));
    const soaked = risks.some((r) => /WATERLOGGED/i.test(r.key || ""));

    let line;
    if (w.current_precip_in > 0.01) {
      line = rainAhead >= 0.05
        ? `Rain on the garden now, <i>${escapeHTML(rainStr)}"</i> more to come.`
        : `Rain on the garden right now.`;
    } else if (rainAhead >= 0.05) {
      line = `<i>${escapeHTML(rainStr)}"</i> of rain in the next day.`;
    } else if (dry) {
      line = `No rain coming. Water within the day.`;
    } else if (soaked) {
      line = `The beds are soaked. Hold off watering.`;
    } else {
      line = `No rain ahead. The garden is holding its own.`;
    }
    $("reading-line").innerHTML = line;
    $("reading-dot").className = "reading-dot" + (risks.length ? " warn" : "");
    // The line already speaks for rain; the meta carries place + temperature.
    const parts = [];
    if (name) parts.push(escapeHTML(name));
    parts.push(now + "°F");
    parts.push("next day " + lo + "–" + hi + "°F");
    $("reading-meta-text").textContent = parts.join(" · ");
    plate.classList.remove("hidden");
  }

  function renderSetupNote() {
    const note = $("setup-note");
    const txt  = $("setup-text");
    // `location` is withheld from non-members, so lean on has_location to tell "not set up"
    // apart from "set up, but not shown to me", and never point a viewer at settings.
    if (!state.has_location) {
      note.classList.remove("hidden");
      txt.textContent = state.can_edit
        ? "Set your location in settings to start fetching weather."
        : "This garden hasn't been set up yet.";
    } else if (!state.weather) {
      note.classList.remove("hidden");
      txt.textContent = state.can_edit
        ? `Couldn't find weather for "${state.prefs.location}". Try a different city or zip in settings.`
        : "Weather for this garden is unavailable right now.";
    } else {
      note.classList.add("hidden");
    }
  }

  function renderEditAffordances() {
    // A viewer who can't write shouldn't be shown a settings door that 403s.
    $("settings-btn").classList.toggle("hidden", !state.can_edit);
  }

  // One meter row per measure: glyph, a quiet track with the comfort band
  // marked, a severity-colored dot at the reading, and the value in figures.
  // Severity is the dot's color alone (semantic colors, never channels):
  // in the band = green, drifting = amber, extreme = red.
  function meterRow(channel, score, value) {
    const clamped = Math.max(-2, Math.min(2, score));
    const pct = 50 + (clamped * 23);
    const icon = { water: "ph-drop", temp: "ph-thermometer", sun: "ph-sun" }[channel];
    const sev = Math.abs(clamped) <= 1 ? "ok" : Math.abs(clamped) <= 1.5 ? "warn" : "bad";
    const val =
      channel === "water" ? value.toFixed(1) + '"' :
      channel === "temp"  ? Math.round(value) + "°F" :
                            "UV " + value.toFixed(1);
    const tooltip = describeScore(channel, score, value);
    return (
      `<div class="meter" title="${escapeHTML(tooltip)}" aria-label="${escapeHTML(tooltip)}">` +
        `<i class="ph-light ${icon} meter-icon"></i>` +
        `<span class="meter-track"><span class="meter-band"></span><span class="meter-mid"></span>` +
          `<span class="meter-dot ${sev}" style="left:${pct.toFixed(2)}%"></span></span>` +
        `<span class="meter-val">${escapeHTML(val)}</span>` +
      `</div>`
    );
  }

  function riskBadgeHtml(risk) {
    const style = RISK_STYLES[risk.key] || { tone: "warn", icon: "ph-warning" };
    // Visible state is just the colored icon chip; the label + advice spans are hidden
    // by default and revealed by the .expanded class (click) or surfaced via the title
    // attribute as a native hover tooltip.
    const tip = `${risk.key} — ${risk.advice}`;
    return (
      `<button type="button" class="risk-badge risk--${style.tone}" ` +
        `title="${escapeHTML(tip)}" aria-label="${escapeHTML(tip)}">` +
        `<i class="ph-light ${escapeHTML(style.icon)}" aria-hidden="true"></i>` +
        `<span class="risk-label">${escapeHTML(risk.key)}</span>` +
        `<span class="risk-advice">${escapeHTML(risk.advice)}</span>` +
      '</button>'
    );
  }

  function plantCardHtml(s) {
    const risks = Array.isArray(s.risks) && s.risks.length
      ? `<span class="risk-row">${s.risks.map(riskBadgeHtml).join("")}</span>`
      : "";
    return (
      '<article class="plant-card">' +
        '<div class="plant-head">' +
          `<span class="plant-icon"><i class="ph-light ${escapeHTML(s.icon)} icon-sm"></i></span>` +
          `<span class="plant-name">${escapeHTML(s.label)}</span>` +
          risks +
        '</div>' +
        '<div class="meters">' +
          meterRow("water", s.water, s.water_value) +
          meterRow("temp",  s.temp,  s.temp_value)  +
          meterRow("sun",   s.sun,   s.sun_value)   +
        '</div>' +
      '</article>'
    );
  }

  // Click-to-expand: tapping a badge opens it inline; tapping again or another badge
  // on the same card collapses the prior one. Mouse users still get the native title
  // tooltip on hover, so this is primarily for touch + explicit-click flows.
  function wireRiskBadgeClicks(container) {
    container.querySelectorAll(".risk-badge").forEach((badge) => {
      badge.addEventListener("click", () => {
        const wasExpanded = badge.classList.contains("expanded");
        const card = badge.closest(".plant-card");
        if (card) card.querySelectorAll(".risk-badge.expanded").forEach((b) => b.classList.remove("expanded"));
        if (!wasExpanded) badge.classList.add("expanded");
      });
    });
  }

  function renderPlants() {
    const container = $("plants");
    const empty = $("empty-note");
    if (!state.weather || state.statuses.length === 0) {
      container.innerHTML = "";
      const noPlantsPicked = state.prefs.plants.length === 0;
      if (state.has_location && state.weather && noPlantsPicked) {
        empty.querySelector("span").textContent = state.can_edit
          ? "No plants picked yet — open settings to choose what's growing."
          : "No plants picked yet.";
        empty.classList.remove("hidden");
      } else {
        empty.classList.add("hidden");
      }
      return;
    }
    empty.classList.add("hidden");
    const sorted = state.statuses.slice().sort((a, b) => a.label.localeCompare(b.label));
    container.innerHTML = sorted.map(plantCardHtml).join("");
    wireRiskBadgeClicks(container);
  }

  function render() {
    renderReading();
    renderEditAffordances();
    renderSetupNote();
    renderPlants();
  }

  // ----- Settings dialog -----------------------------------------------------------------
  function renderSoilOptions() {
    const sel = $("cfg-soil");
    const desc = $("cfg-soil-desc");
    sel.innerHTML = state.soil_types.map((s) => (
      `<option value="${escapeHTML(s.key)}"${s.key === draft.soil ? ' selected' : ''}>${escapeHTML(s.label)}</option>`
    )).join("");
    const refreshDesc = () => {
      const cur = state.soil_types.find((s) => s.key === draft.soil);
      desc.textContent = cur ? cur.description : "";
    };
    refreshDesc();
    sel.addEventListener("change", () => {
      draft.soil = sel.value;
      refreshDesc();
    });
  }

  function renderPlantOptions() {
    const grid = $("cfg-plants");
    const set = new Set(draft.plants);
    const sorted = state.plant_types.slice().sort((a, b) => a.label.localeCompare(b.label));
    grid.innerHTML = sorted.map((p) => (
      '<label class="plant-option' + (set.has(p.key) ? ' checked' : '') + '">' +
        `<input type="checkbox" value="${escapeHTML(p.key)}"${set.has(p.key) ? ' checked' : ''}>` +
        `<span class="plant-icon"><i class="ph-light ${escapeHTML(p.icon)} icon-sm"></i></span>` +
        `<span class="plant-label">${escapeHTML(p.label)}</span>` +
      '</label>'
    )).join("");
    grid.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.addEventListener("change", () => {
        const key = el.value;
        const present = draft.plants.indexOf(key);
        if (el.checked && present === -1) draft.plants.push(key);
        if (!el.checked && present !== -1) draft.plants.splice(present, 1);
        el.closest(".plant-option").classList.toggle("checked", el.checked);
      });
    });
  }

  function openSettings() {
    draft = {
      location: state.prefs.location,
      soil: state.prefs.soil,
      plants: state.prefs.plants.slice(),
    };
    $("cfg-location").value = draft.location;
    renderSoilOptions();
    renderPlantOptions();
    $("settings-overlay").classList.remove("hidden");
  }
  function closeSettings() {
    $("settings-overlay").classList.add("hidden");
    draft = null;
  }
  async function saveSettings() {
    if (!draft) return closeSettings();
    draft.location = $("cfg-location").value.trim().slice(0, 120);
    try {
      await frame.api("api/save", draft);
      closeSettings();
      await loadState();
    } catch (e) {
      await frame.alert("Couldn't save: " + (e?.body || e?.message || String(e)));
    }
  }

  // ----- Bootstrap + push --------------------------------------------------------------
  async function loadState() {
    try {
      state = await frame.api("api/state");
      render();
    } catch (e) {
      if (e?.status === 403) {
        document.body.innerHTML =
          '<div class="note"><i class="ph-light ph-lock-simple icon-sm"></i> Forbidden.</div>';
        return;
      }
      console.error(e);
    }
  }

  $("settings-btn").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  $("settings-cancel").addEventListener("click", closeSettings);
  $("settings-save").addEventListener("click", saveSettings);
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === $("settings-overlay")) closeSettings();
  });

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "settings_changed") loadState();
  });

  // Refresh weather/statuses every 5 minutes — backend cache is 15min so most refreshes
  // are cheap, but this keeps the dial honest as forecasts roll forward.
  setInterval(loadState, 5 * 60 * 1000);

  loadState();
})();
