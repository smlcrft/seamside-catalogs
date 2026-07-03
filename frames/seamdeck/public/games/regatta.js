// regatta.js — the Regatta cartridge: game definition + play screen.
// Pure rules (course, wind polar, integrator, scoring) live in regatta-sim.js;
// the race lifecycle (countdown, clock, beacons, submit) is useRaceRunner —
// this file is almost entirely rendering.
//
// A REALTIME race: everyone casts off together after the countdown. Steer with
// ←/→; the wind blows from the top of the course, so the upwind marks demand
// real tacking. Rivals sail the same water live (position beacons → ghosts).
import { html } from "/lib/js/framelib.js";
import { useRaceRunner } from "../console-kit.js";
import {
  MAX_MS, NO_GO, MARK_R, FINISH_R,
  courseFor, integrate, resolve, fmtTime,
} from "./regatta-sim.js";

const STYLE = `
  .rg-map { position: absolute; inset: 0; }
  .rg-mark { position: absolute; transform: translate(-50%, -50%); border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--os-font-mono); font-size: var(--os-fs-2xs);
    border: 2px solid color-mix(in srgb, var(--os-text), transparent 55%); color: var(--os-text-muted); }
  .rg-mark.next { border-color: var(--ch); color: var(--ch); }
  .rg-mark.rounded { opacity: 0.3; }
  .rg-finish { position: absolute; transform: translate(-50%, -50%); border-radius: 50%;
    border: 2px dashed color-mix(in srgb, var(--os-text), transparent 60%);
    display: flex; align-items: center; justify-content: center; color: var(--os-text-muted); }
  .rg-finish.next { border-color: var(--ch); color: var(--ch); }
  .rg-boat { position: absolute; width: 15px; height: 22px;
    background: var(--os-text);
    clip-path: polygon(50% 0, 88% 100%, 50% 80%, 12% 100%);
    transition: opacity var(--os-transition-fast); }
  .rg-boat.luff { animation: rg-flap 300ms infinite; }
  @keyframes rg-flap { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
  .rg-ghost { position: absolute; width: 13px; height: 19px;
    background: color-mix(in srgb, var(--os-text), transparent 55%);
    clip-path: polygon(50% 0, 88% 100%, 50% 80%, 12% 100%);
    transition: left 380ms linear, top 380ms linear; }
  .rg-ghost-tag { position: absolute; transform: translate(-50%, 8px);
    font-family: var(--os-font-mono); font-size: 8px; letter-spacing: 0.08em;
    color: var(--os-text-subtle); white-space: nowrap;
    transition: left 380ms linear, top 380ms linear; }
  .rg-wind { position: absolute; top: 8px; left: 12px; display: flex; align-items: center; gap: 5px;
    font-family: var(--os-font-mono); font-size: var(--os-fs-2xs); color: var(--os-text-subtle); }
  .rg-wind i { font-size: 14px; }
  .rg-clock { position: absolute; top: 8px; right: 12px;
    font-family: var(--os-font-mono); font-size: var(--os-fs-2xs); color: var(--os-text-subtle); }
  .rg-luff-hint { position: absolute; top: 26%; left: 50%; transform: translateX(-50%);
    font-family: var(--os-font-mono); font-size: var(--os-fs-2xs); letter-spacing: 0.14em;
    color: var(--os-cError, #c0392b); }
`;

function PlayScreen({ ctx }) {
  const course = courseFor(ctx.seed);
  const { phase, count, elapsed, flash, live } = useRaceRunner(ctx, {
    duration: MAX_MS,
    integrate,
    isFinished: (b) => b.finishedAt !== null,
    record: (name, edge, t) =>
      name === "left" || name === "right" ? { t, k: name, e: edge } : null,
    beaconFor: (b) => ({
      x: b.x, y: b.y, heading: b.heading,
      note: b.next < course.marks.length ? `mark ${b.next + 1}/3` : "→ finish",
    }),
    resolve,
    flashFor: (r) => r.finishedAt === null
      ? { main: "DNF", sub: "time ran out" }
      : { main: fmtTime(r.finishedAt), sub: `+${r.points}` },
  });

  const sailing = phase === "running" || phase === "flash";
  const boat = sailing ? (live || integrate([], ctx.seed, 0)) : null;
  const next = boat ? boat.next : 0;
  const luffing = phase === "running" && boat && boat.offWind < NO_GO;
  const ghosts = (ctx.racers || []).filter((r) => r.client_id !== ctx.clientId);
  const nameOf = (seat_no) => {
    const s = ctx.seats.find((x) => x.seat_no === seat_no);
    return s ? (s.initials || (s.display_name || "").slice(0, 4)) : "";
  };
  // world (100×100, y down) → field percent, with a margin so icons stay inside
  const px = (v) => 4 + v * 0.92;
  const markSize = MARK_R * 2 * 0.92;

  return html`
    <div class="field">
      <style>${STYLE}</style>
      <div class="rg-map">
        <div class="rg-wind">
          <i class="ph-light ph-wind"></i>
          <i class="ph-light ph-arrow-up" style=${`transform: rotate(${course.windFrom + Math.PI}rad);`}></i>
        </div>
        ${sailing ? html`<div class="rg-clock">${fmtTime(Math.min(elapsed, MAX_MS))}</div>` : ""}
        ${course.marks.map((m, i) => html`
          <div key=${i} class=${`rg-mark ${boat && next === i ? "next" : ""} ${boat && next > i ? "rounded" : ""}`}
            style=${`left:${px(m.x)}%; top:${px(m.y)}%; width:${markSize}%; aspect-ratio:1;`}>${i + 1}</div>`)}
        <div class=${`rg-finish ${boat && next >= course.marks.length ? "next" : ""}`}
          style=${`left:${px(course.start.x)}%; top:${px(course.start.y)}%; width:${FINISH_R * 2 * 0.92}%; aspect-ratio:1;`}>
          <i class="ph-light ph-flag-checkered"></i>
        </div>
        ${ghosts.map((g) => html`
          <div key=${g.client_id}>
            <div class="rg-ghost" style=${`left:calc(${px(g.x)}% - 6.5px); top:calc(${px(g.y)}% - 9.5px); transform: rotate(${g.heading}rad);`}></div>
            <div class="rg-ghost-tag" style=${`left:${px(g.x)}%; top:${px(g.y)}%;`}>${nameOf(g.seat_no)}</div>
          </div>`)}
        ${boat ? html`
          <div class=${`rg-boat ${luffing ? "luff" : ""}`}
            style=${`left:calc(${px(boat.x)}% - 7.5px); top:calc(${px(boat.y)}% - 11px); transform: rotate(${boat.heading}rad);`}></div>` : ""}
        ${luffing ? html`<div class="rg-luff-hint">IN IRONS — BEAR AWAY</div>` : ""}
      </div>
      ${phase === "count" ? html`<div class="flash">${count}</div>` : ""}
      ${flash ? html`<div class=${`flash ${flash.main === "DNF" ? "foul" : ""}`}>
        ${flash.main}<span class="flash-sub">${flash.sub}</span>
      </div>` : ""}
      ${phase === "watch" && !flash
        ? html`<div class="prompt">${ctx.mySeat ? "waiting for the fleet" : "watching the race"}</div>`
        : ""}
      ${phase === "running" && boat
        ? html`<div class="game-read">${boat.next < course.marks.length ? `round mark ${boat.next + 1}` : "run for the finish"}</div>`
        : ""}
    </div>`;
}

export const regatta = {
  id: "regatta",
  title: "Regatta",
  icon: "sailboat",
  blurb: "Tack around the marks. Beat the fleet home.",
  available: true,
  mode: "race",
  attempts: 1,
  screen: PlayScreen,
};
