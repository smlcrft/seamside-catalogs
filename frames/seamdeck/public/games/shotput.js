// shotput.js — the Shot Put cartridge: game definition + play screen.
// Pure game rules live in shotput-sim.js (shared with the worker + tests);
// this file is everything the player sees. Fork this pair to make your own game.
import { html, useState, useRef } from "/lib/js/framelib.js";
import { useInput, useTurnRunner, animator, wait } from "../console-kit.js";
import { MAX_DISTANCE, ATTEMPTS, targetFor, simulate, score } from "./shotput-sim.js";

const CHARGE_MS = 2400;     // ms of held-O from zero power to the foul line
const FOUL_X = 16;          // % — the foul line / release point
const FAR_X = 92;           // % — where MAX_DISTANCE maps to
const EXIT_X = 108;         // % — offscreen right, where the athlete runs off to
const GROUND = 26;          // % from bottom — the ground baseline
const THROW_MS = 900;
const EXIT_MS = 650;        // the post-series sprint offscreen
const distanceToX = (d) => FOUL_X + (Math.min(d, MAX_DISTANCE) / MAX_DISTANCE) * (FAR_X - FOUL_X);

const STYLE = `
  .sp-ground { position: absolute; left: 0; right: 0; bottom: ${GROUND}%; height: 2px;
    background: color-mix(in srgb, var(--os-text), transparent 78%); }
  .sp-foul-line { position: absolute; bottom: ${GROUND}%; height: 22%; width: 0;
    border-left: 2px dashed color-mix(in srgb, var(--ch), transparent 25%); }
  .sp-target { position: absolute; width: 58px; height: 58px; transform: translate(-50%, 50%); border-radius: 50%;
    background: repeating-radial-gradient(circle, color-mix(in srgb, var(--ch), transparent 12%) 0 2px, transparent 2px 9px); }
  .sp-target-num { position: absolute; top: -16px; left: 50%; transform: translateX(-50%); white-space: nowrap;
    font-family: var(--os-font-mono); font-size: var(--os-fs-2xs); color: var(--os-text-muted); }
  .sp-athlete { position: absolute; transform: translate(-50%, 0); color: var(--os-text); line-height: 0; }
  .sp-athlete i { font-size: 42px; }
  .sp-ball { position: absolute; width: 13px; height: 13px; border-radius: 50%; transform: translate(-50%, 50%);
    background: var(--os-text); box-shadow: 0 1px 4px color-mix(in srgb, #000, transparent 70%); }
  .sp-meter-foul { position: absolute; top: 0; bottom: 0; right: 0; width: 6%;
    background: color-mix(in srgb, var(--os-cError, #c0392b), transparent 40%); }
`;

// ---------------------------------------------------------------------------
// Field — runs the LIVE charge→release for the active player and REPLAYS every
// other player's throw from its stored payload through the same pure sim, so
// all peers see each throw a beat after it lands.
// ---------------------------------------------------------------------------
function PlayScreen({ ctx }) {
  const target = targetFor(ctx.seed);
  const [mode, setMode] = useState("ready"); // ready|charging|flying|done|exiting|idle
  const [charge, setCharge] = useState(0);
  const [prog, setProg] = useState(0);
  const [result, setResult] = useState(null); // {landing, foul, points}
  const [flash, setFlash] = useState(null);   // {main, sub}

  const anim = useRef(null);
  if (!anim.current) anim.current = animator();
  const raf = useRef(0);
  const chargeRef = useRef(0);
  const charging = useRef(false);

  const runner = useTurnRunner({
    turns: ctx.turns, clientId: ctx.clientId, attempts: ATTEMPTS,
    replay: async (row, isFinal) => {
      const c = Math.min(1.5, Math.max(0, Number(row.payload && row.payload.charge) || 0));
      setMode("charging"); setResult(null); setCharge(0);
      await anim.current.run(Math.max(250, Math.min(1, c) * CHARGE_MS), (t) => setCharge(Math.min(1, c) * t));
      await flight(c, c >= 1, false, isFinal);
    },
  });

  // The shared release→arc→flash sequence (identical for live + replay). The
  // athlete stays planted at the line while the ball flies; after their FINAL
  // attempt lands, they sprint off the right edge of the screen (series done).
  async function flight(c, foul, submit, isFinal) {
    const landing = c * MAX_DISTANCE;
    const points = foul ? 0 : score(landing, target);
    setResult({ landing, foul, points });
    setMode("flying");
    await anim.current.run(foul ? 420 : THROW_MS, (t) => setProg(t));
    setMode("done");
    setFlash({
      main: foul ? "FOUL" : points === 100 ? "PERFECT!" : `+${points}`,
      sub: foul ? "" : `${landing.toFixed(1)} m`,
    });
    if (isFinal) {
      setProg(0); // fresh tween — never reuse the flight's settled prog
      setMode("exiting");
      await anim.current.run(EXIT_MS, (t) => setProg(t));
      await wait(300);
    } else {
      await wait(900);
    }
    if (submit) await ctx.submit({ charge: c });
    setFlash(null); setResult(null); setProg(0); setCharge(0); setMode("idle");
  }

  // ---- live charge for the active player ----
  function beginCharge() {
    runner.beginLive();
    charging.current = true;
    setMode("charging");
    const start = performance.now();
    const loop = (now) => {
      const c = (now - start) / CHARGE_MS;
      if (c >= 1) { chargeRef.current = 1; setCharge(1); finishThrow(1, true); return; } // auto-foul
      chargeRef.current = c; setCharge(c);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
  }
  async function finishThrow(c, foul) {
    if (!charging.current) return; // release after auto-foul (or double-fire) is a no-op
    charging.current = false;
    cancelAnimationFrame(raf.current);
    await flight(c, foul, true, ctx.attempt >= ATTEMPTS - 1); // my last attempt → run off
    runner.endLive();
  }

  const myTurns = ctx.turns.filter((t) => t.client_id === ctx.clientId).length;
  const canCharge = ctx.isMyTurn && myTurns === ctx.attempt && runner.settled();

  useInput((name, edge) => {
    if (name !== "A") return;
    // Down starts a charge only when it's my clear turn; release is gated only
    // by the live charge ref so it always fires (canCharge flips false mid-charge).
    if (edge === "down") { if (canCharge && !charging.current) beginCharge(); }
    else if (charging.current) finishThrow(chargeRef.current, chargeRef.current >= 1);
  });

  // ---- derived positions ----
  const landingX = result ? distanceToX(result.landing) : FOUL_X;
  const fouled = result && result.foul;
  let athleteX = 4 + (FOUL_X - 4) * Math.min(charge, 1);
  let ballStyle = "display:none;";
  if (mode === "flying") {
    const x = FOUL_X + (landingX - FOUL_X) * prog;
    const arc = (fouled ? 8 : 40) * Math.sin(Math.PI * prog);
    ballStyle = `left:${x}%; bottom:calc(${GROUND}% + ${arc}%);`;
    athleteX = FOUL_X; // planted at the line, watching the ball
  } else if (mode === "done") {
    athleteX = FOUL_X;
    ballStyle = fouled ? "display:none;" : `left:${landingX}%; bottom:${GROUND}%;`;
  } else if (mode === "exiting") {
    athleteX = FOUL_X + (EXIT_X - FOUL_X) * prog; // series over — sprint offscreen
    ballStyle = fouled ? "display:none;" : `left:${landingX}%; bottom:${GROUND}%;`;
  }
  // The pose tells the story: standing → wind-up (throw stance, creeping to the
  // line) → release snaps back to standing as the ball flies → after the LAST
  // attempt lands, a RUN carries them off the right edge.
  const sprite =
    mode === "charging" ? "person-simple-throw"
    : mode === "exiting" ? "person-simple-run"
    : "person-simple";
  const meterPct = mode === "charging" ? Math.min(charge, 1) * 100 : 0;

  return html`
    <div class="field">
      <style>${STYLE}</style>
      <div class="game-read">target ${target}m</div>
      <div class="sp-ground"></div>
      <div class="sp-foul-line" style=${`left:${FOUL_X}%;`}></div>
      <div class="sp-target" style=${`left:${distanceToX(target)}%; bottom:${GROUND}%;`}>
        <span class="sp-target-num">${target}m</span>
      </div>
      <div class="sp-athlete" style=${`left:${athleteX}%; bottom:${GROUND}%;`}>
        <i class=${`ph-light ph-${sprite}`}></i>
      </div>
      <div class="sp-ball" style=${ballStyle}></div>
      ${flash ? html`<div class=${`flash ${fouled ? "foul" : result && result.points === 100 ? "perfect" : ""}`}>
        ${flash.main}
        ${flash.sub ? html`<span class="flash-sub">${flash.sub}</span>` : ""}
      </div>` : ""}
      <div class="meter">
        <div class="meter-fill" style=${`width:${meterPct}%;`}></div>
        <div class="meter-tick" style=${`left:${(target / MAX_DISTANCE) * 100}%;`}></div>
        <div class="sp-meter-foul"></div>
      </div>
      ${canCharge && (mode === "ready" || mode === "idle")
        ? html`<div class="prompt">hold <b>O</b> to charge — release at the mark</div>`
        : ""}
    </div>`;
}

export const shotput = {
  id: "shotput",
  title: "Shot Put",
  icon: "person-simple-throw",
  blurb: "Hold O, release at the mark.",
  available: true,
  mode: "turns",
  attempts: ATTEMPTS,
  screen: PlayScreen,
};
