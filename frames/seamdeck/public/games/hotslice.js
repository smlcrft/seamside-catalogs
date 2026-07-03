// hotslice.js — the Hot Slice cartridge: game definition + play screen.
// Pure rules (course, physics, scoring) live in hotslice-sim.js; the race
// lifecycle (countdown, clock, beacons, submit) is useRaceRunner — this file
// is almost entirely rendering.
//
// A REALTIME race: after the countdown, everyone rides the same street at once.
// Alternate O/I to pedal (two thumbs, real cadence); UP (road) / DOWN (kerb)
// to switch lanes; run over pizzas, not cones. Rivals appear live ahead of/
// behind you.
import { html } from "/lib/js/framelib.js";
import { useRaceRunner } from "../console-kit.js";
import { DURATION, VMAX, courseFor, integrate, resolve } from "./hotslice-sim.js";

const RIDER_X = 18;       // % — my bike's fixed screen position
const PX_PER_M = 1.7;     // % of screen width per metre of street
const LANE_Y = [28, 50];  // % from bottom — kerb lane, road lane

const STYLE = `
  .hs-road { position: absolute; left: 0; right: 0; height: 2px;
    background: color-mix(in srgb, var(--os-text), transparent 80%); }
  .hs-rider { position: absolute; transform: translate(-50%, 0); line-height: 0;
    color: var(--os-text); transition: bottom 140ms ease-out; }
  .hs-rider i { font-size: 38px; }
  .hs-rider.stalled { color: var(--os-cError, #c0392b); }
  .hs-ghost { position: absolute; transform: translate(-50%, 0); line-height: 0;
    color: color-mix(in srgb, var(--os-text), transparent 55%); transition: left 380ms linear, bottom 140ms ease-out; }
  .hs-ghost i { font-size: 34px; }
  .hs-ghost-tag { position: absolute; transform: translate(-50%, 2px);
    font-family: var(--os-font-mono); font-size: 8px; letter-spacing: 0.08em;
    color: var(--os-text-subtle); white-space: nowrap; }
  .hs-item { position: absolute; transform: translate(-50%, 0); line-height: 0; font-size: 24px; }
  .hs-tick { position: absolute; bottom: 39%; width: 2px; height: 9px;
    background: color-mix(in srgb, var(--os-text), transparent 80%); }
  .hs-item.pizza { color: var(--ch); }
  .hs-item.cone { color: var(--os-text-muted); }
  .hs-clock { position: absolute; top: 8px; right: 12px;
    font-family: var(--os-font-mono); font-size: var(--os-fs-2xs); color: var(--os-text-subtle); }
  .hs-slices { position: absolute; top: 8px; left: 12px; display: flex; gap: 4px;
    color: var(--ch); font-size: 14px; }
`;

function PlayScreen({ ctx }) {
  const { phase, count, elapsed, flash, live } = useRaceRunner(ctx, {
    duration: DURATION,
    integrate,
    record: (name, edge, t) =>
      edge === "down" && ["up", "down", "A", "B"].includes(name) ? { t, k: name } : null,
    beaconFor: (r) => ({ x: r.dist, y: r.lane, note: `${Math.round(r.dist)} m` }),
    resolve,
    flashFor: (r) => ({ main: r.allPizzas ? "DELIVERED HOT!" : `+${r.points}`, sub: r.summary }),
  });

  const active = phase === "running" || phase === "flash";
  const ride = active ? live : null;
  const dist = ride ? ride.dist : 0;
  const lane = ride ? ride.lane : 0;
  const speed = ride ? ride.v : 0;
  const recentHit = ride && ride.hit.some((h, i) => h && Math.abs(ride.course[i].d - dist) < 6);
  const pizzas = ride ? ride.got.filter(Boolean).length : 0;
  const secondsLeft = active ? Math.max(0, Math.ceil((DURATION - elapsed) / 1000)) : 0;

  // Camera: my ride when racing; otherwise chase the leading ghost.
  const ghosts = (ctx.racers || []).filter((r) => r.client_id !== ctx.clientId);
  const camera = active ? dist : ghosts.reduce((m, g) => Math.max(m, g.x || 0), 0);
  const nameOf = (seat_no) => {
    const s = ctx.seats.find((x) => x.seat_no === seat_no);
    return s ? (s.initials || (s.display_name || "").slice(0, 4)) : "";
  };
  const course = courseFor(ctx.seed); // the street exists for spectators too

  return html`
    <div class="field">
      <style>${STYLE}</style>
      ${LANE_Y.map((y) => html`<div class="hs-road" style=${`bottom:${y}%;`}></div>`)}
      ${Array.from({ length: 22 }, (_, k) => {
        const x = RIDER_X + (k * 15 - camera) * PX_PER_M;
        if (x < -2 || x > 102) return "";
        return html`<div key=${`t${k}`} class="hs-tick" style=${`left:${x}%;`}></div>`;
      })}
      ${course.map((it, i) => {
        if (ride && ride.got[i]) return "";
        const x = RIDER_X + (it.d - camera) * PX_PER_M;
        if (x < -4 || x > 104) return "";
        return html`<div key=${i} class=${`hs-item ${it.kind}`} style=${`left:${x}%; bottom:${LANE_Y[it.lane]}%;`}>
          <i class=${`ph-light ph-${it.kind === "pizza" ? "pizza" : "traffic-cone"}`}></i>
        </div>`;
      })}
      ${ghosts.map((g) => {
        const x = RIDER_X + ((g.x || 0) - camera) * PX_PER_M;
        if (x < -6 || x > 106) return "";
        return html`<div key=${g.client_id}>
          <div class="hs-ghost" style=${`left:${x}%; bottom:${LANE_Y[g.y === 1 ? 1 : 0]}%;`}>
            <i class="ph-light ph-person-simple-bike"></i>
          </div>
          <div class="hs-ghost-tag" style=${`left:${x}%; bottom:${LANE_Y[g.y === 1 ? 1 : 0] - 5}%;`}>${nameOf(g.seat_no)}</div>
        </div>`;
      })}
      ${active ? html`
        <div class=${`hs-rider ${recentHit ? "stalled" : ""}`} style=${`left:${RIDER_X}%; bottom:${LANE_Y[lane]}%;`}>
          <i class="ph-light ph-person-simple-bike"></i>
        </div>
        <div class="hs-clock">${secondsLeft}s</div>
        <div class="hs-slices">
          ${Array.from({ length: pizzas }, (_, i) => html`<i key=${i} class="ph-light ph-pizza"></i>`)}
        </div>
        <div class="game-read">pedal <b>O</b>·<b>I</b> · lanes ↑↓</div>` : ""}
      ${phase === "count" ? html`<div class="flash">${count}</div>` : ""}
      ${flash ? html`<div class=${`flash ${flash.main === "DELIVERED HOT!" ? "perfect" : ""}`}>
        ${flash.main}<span class="flash-sub">${flash.sub}</span>
      </div>` : ""}
      ${phase === "watch" && !flash
        ? html`<div class="prompt">${ctx.mySeat ? "waiting for the field" : "watching the race"}</div>`
        : ""}
      <div class="meter">
        <div class="meter-fill" style=${`width:${(speed / VMAX) * 100}%;`}></div>
      </div>
    </div>`;
}

export const hotslice = {
  id: "hotslice",
  title: "Hot Slice",
  icon: "person-simple-bike",
  blurb: "Pedal like mad. Deliver the pie.",
  available: true,
  mode: "race",
  attempts: 1,
  screen: PlayScreen,
};
