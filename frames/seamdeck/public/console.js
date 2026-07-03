import {
    frame,
    html,
    render,
    useState,
    useEffect,
    useRef,
    useCallback,
    useFramePush,
    applyChannel,
} from "/lib/js/framelib.js";
import { GAMES, gameById } from "./games/registry.js";
// The console core knows NO game rules. Games live in ./games/* as
// self-contained cartridge modules (see games/README.md); the shared input
// bus + helpers live in console-kit.js so game files can import them too.
import { inputBus, useInput, useCaptureInput } from "./console-kit.js";

// Screens lay out as a vertical list when narrow and a grid when wide, so d-pad
// navigation must follow the SAME geometry the eye sees. isWide() mirrors the
// CSS breakpoint; gridMove clamps a focus index through an n-item, `cols`-wide grid.
const isWide = () => matchMedia("(min-width: 720px)").matches;
function gridMove(sel, name, n, cols) {
    if (name === "left") return Math.max(0, sel - 1);
    if (name === "right") return Math.min(n - 1, sel + 1);
    if (name === "up") return Math.max(0, sel - cols);
    if (name === "down") return Math.min(n - 1, sel + cols);
    return sel;
}

// Physical key → console input. Two action buttons "A" (primary) / "B" (secondary)
// are the internal names used by game logic; on-screen they're labelled O / I and
// bound to the O / I keys. Movement takes arrows AND WASD.
const KEYMAP = {
    ArrowUp: "up",
    KeyW: "up",
    ArrowDown: "down",
    KeyS: "down",
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
    KeyO: "A", // primary (amber, labelled O)
    KeyI: "B", // secondary (labelled I)
};
// Registered once by App. keydown(non-repeat)→down, keyup→up.
function useKeyboard() {
    useEffect(() => {
        // Ignore console keys while a text field is focused (e.g. the initials input),
        // so typing "A"/"O"/"I"/WASD there enters characters instead of firing the pad.
        const typing = (e) => {
            const t = e.target;
            return (
                t &&
                (t.tagName === "INPUT" ||
                    t.tagName === "TEXTAREA" ||
                    t.isContentEditable)
            );
        };
        const down = (e) => {
            if (typing(e)) return;
            const n = KEYMAP[e.code];
            if (!n || e.repeat) return;
            e.preventDefault();
            inputBus.emit(n, "down");
        };
        const up = (e) => {
            if (typing(e)) return;
            const n = KEYMAP[e.code];
            if (!n) return;
            e.preventDefault();
            inputBus.emit(n, "up");
        };
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
        };
    }, []);
}

// ===========================================================================
// Player identity — per-device client_id sent with every request.
// ===========================================================================
let CLIENT_ID = null;
async function ensureClientId() {
    if (CLIENT_ID) return CLIENT_ID;
    let id = await frame.localStorageGetItem("client_id");
    if (!id) {
        id =
            (crypto.randomUUID && crypto.randomUUID()) ||
            Date.now().toString(36) +
                Math.random().toString(36).slice(2);
        await frame.localStorageSetItem("client_id", id);
    }
    CLIENT_ID = id;
    return id;
}

// Every mutating call carries the caller's client_id.
async function act(path, body = {}) {
    const cid = await ensureClientId();
    try {
        return await frame.api(path, { ...body, client_id: cid });
    } catch (e) {
        // Screens recover by refetching; the warn is for people building forks.
        console.warn(`[seamdeck] ${path} failed:`, e);
        throw e;
    }
}

// ===========================================================================
// ControlDeck — dpad + A/B. Emits input on pointer; lights up (echo) on any
// input event so keyboard presses visibly press the on-screen keys too.
// ===========================================================================
// One continuous rounded plus (96×96, 32px arms): outer corners r6, concave inner
// corners r6 — a single path means a single fill, so the cross has no seams.
const DPAD_PATH =
    "M38 0 H58 Q64 0 64 6 V26 Q64 32 70 32 H90 Q96 32 96 38 V58 Q96 64 90 64 " +
    "H70 Q64 64 64 70 V90 Q64 96 58 96 H38 Q32 96 32 90 V70 Q32 64 26 64 " +
    "H6 Q0 64 0 58 V38 Q0 32 6 32 H26 Q32 32 32 26 V6 Q32 0 38 0 Z";

function ControlDeck({ onHome }) {
    const [pressed, setPressed] = useState({});
    useInput((name, edge) =>
        setPressed((p) => ({ ...p, [name]: edge === "down" })),
    );

    const press = (name) => (e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        inputBus.emit(name, "down");
    };
    const release = (name) => (e) => {
        e.preventDefault();
        inputBus.emit(name, "up");
    };

    const key = (name, cls, inner) =>
        html` <button
            class=${`key ${cls} ${pressed[name] ? "pressed" : ""}`}
            onPointerDown=${press(name)}
            onPointerUp=${release(name)}
            onPointerCancel=${release(name)}
            aria-label=${name}
        >
            ${inner}
        </button>`;

    // Tilt the whole cross toward the pressed arm (rocker d-pad), not per-key.
    // rotateY's near-edge sense is opposite rotateX's, so left/right is negated —
    // otherwise pressing left visibly rocks the pad right (the reported bug).
    const rx = (pressed.up ? 1 : 0) - (pressed.down ? 1 : 0);
    const ry = (pressed.left ? 1 : 0) - (pressed.right ? 1 : 0);
    const dpadTilt = `transform: perspective(280px) rotateX(${rx * 13}deg) rotateY(${-ry * 13}deg);`;

    return html` <div class="deck">
        <div class="dpad" style=${dpadTilt}>
            <svg
                class="dpad-face"
                viewBox="0 0 96 96"
                aria-hidden="true"
            >
                <defs>
                    <linearGradient
                        id="dpad-grad"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                    >
                        <stop
                            offset="0"
                            style="stop-color:var(--key-hi)"
                        />
                        <stop
                            offset="0.65"
                            style="stop-color:var(--key)"
                        />
                    </linearGradient>
                </defs>
                <path
                    d=${DPAD_PATH}
                    fill="url(#dpad-grad)"
                    stroke="rgba(0,0,0,0.3)"
                    stroke-width="1"
                />
                <circle
                    cx="48"
                    cy="48"
                    r="6.5"
                    fill="rgba(0,0,0,0.15)"
                />
                <circle
                    cx="48"
                    cy="48.7"
                    r="6.5"
                    fill="none"
                    stroke="rgba(255,255,255,0.06)"
                    stroke-width="1"
                />
            </svg>
            ${key("up", "up", "")} ${key("left", "left", "")}
            ${key("right", "right", "")} ${key("down", "down", "")}
        </div>
        <button
            class="home"
            onClick=${onHome}
            aria-label="Library"
            title="Library"
        >
            <i class="ph-light ph-cards-three"></i>
        </button>
        <div class="ab">
            ${key(
                "B",
                "B",
                html`<i class="ph-light ph-line-vertical"></i>`,
            )}
            ${key(
                "A",
                "A",
                html`<i class="ph-light ph-circle"></i>`,
            )}
        </div>
    </div>`;
}

// ===========================================================================
// App root
// ===========================================================================
function App() {
    const [state, setState] = useState(null);
    // Which screen THIS device is on — purely local. Multiplayer is opt-in:
    // nobody's console jumps because someone else loaded a game.
    const [view, setView] = useState({ screen: "library" });
    useKeyboard();

    // Coalesce refetches: during a race, position beacons fire state_changed a
    // few times a second per racer — collapse bursts into one in-flight fetch
    // plus at most one queued follow-up.
    const fetching = useRef(false);
    const queued = useRef(false);
    const refetch = useCallback(async () => {
        if (fetching.current) {
            queued.current = true;
            return;
        }
        fetching.current = true;
        try {
            const r = await frame.apiSafe("api/state");
            setState(r);
        } finally {
            fetching.current = false;
            if (queued.current) {
                queued.current = false;
                refetch();
            }
        }
    }, []);

    useEffect(() => {
        ensureClientId().then(refetch);
    }, [refetch]);
    useFramePush({ state_changed: refetch });

    // Accent (--ch) follows the space color; the chrome derives from the theme's
    // ink tone in CSS, so the device inverts light/dark with the space theme.
    const spaceColor =
        state && state.me ? state.me.space_color : null;
    useEffect(() => {
        applyChannel(
            document.documentElement,
            spaceColor || "var(--os-c1)",
        );
    }, [spaceColor]);
    if (!state) return html`<div class="boot">booting…</div>`;
    return html`<${Device}
        state=${state}
        view=${view}
        setView=${setView}
        refetch=${refetch}
    />`;
}

// ===========================================================================
// Device — chassis wrapper: the current view's screen + control deck.
// ===========================================================================
function Device({ state, view, setView, refetch }) {
    const sessions = state.sessions || [];
    const current =
        view.screen === "session"
            ? sessions.find(
                  (s) => s.session_id === view.session_id,
              ) || null
            : null;

    // If the session this device was looking at ended (last player left), bounce
    // home — after a grace window, so a freshly created/joined session that the
    // next state fetch hasn't delivered yet doesn't get mistaken for a dead one.
    useEffect(() => {
        if (view.screen !== "session" || current) return;
        const id = setTimeout(
            () => setView({ screen: "library" }),
            1200,
        );
        return () => clearTimeout(id);
    }, [view.screen, view.session_id, !!current]);

    // The library button always offers to leave; the "I" / Back key leaves
    // too — EXCEPT during play, where I belongs to the game (or to nothing).
    // Leaving a live game you're seated in asks first, via an in-console
    // dialog (never a system modal).
    const [leaveAsk, setLeaveAsk] = useState(null); // null | {sel}
    const seated = !!(current && current.seats.some((st) => st.client_id === CLIENT_ID));

    const doLeave = useCallback(async () => {
        setLeaveAsk(null);
        if (seated) {
            try {
                await act("api/leave");
            } catch (e) {}
        }
        setView({ screen: "library" });
        refetch();
    }, [seated, refetch, setView]);

    const requestLeave = useCallback(() => {
        if (view.screen !== "session") return;
        if (seated && current && current.phase === "playing") {
            setLeaveAsk({ sel: 1 }); // default to Stay — leaving is the exception
            return;
        }
        doLeave();
    }, [view.screen, seated, current, doLeave]);

    // "I" is Back on console screens (lobby, results, watching) — but NOT
    // while a game you're in is live: there it's the game's key, or nothing.
    useInput((name, edge) => {
        if (edge !== "down" || name !== "B") return;
        if (seated && current && current.phase === "playing") return;
        requestLeave();
    });

    // The dialog owns ALL input while open: O picks, I stays.
    useCaptureInput(!!leaveAsk, (name, edge) => {
        if (edge !== "down") return;
        if (name === "B") { setLeaveAsk(null); return; }
        if (name === "up" || name === "down") {
            setLeaveAsk((m) => (m ? { sel: m.sel === 0 ? 1 : 0 } : m));
            return;
        }
        if (name === "A") {
            if (leaveAsk && leaveAsk.sel === 0) doLeave();
            else setLeaveAsk(null);
        }
    });

    // If the round ends (or the session dies) while the dialog is up, drop it.
    useEffect(() => {
        if (leaveAsk && (!current || current.phase !== "playing")) setLeaveAsk(null);
    }, [!!current, current && current.phase]);

    return html` <main class="device">
        <div class="body">
            <div class="screen-bezel">
                <div class="screen">
                    <${Screen}
                        state=${state}
                        view=${view}
                        setView=${setView}
                        refetch=${refetch}
                    />
                    ${leaveAsk
                        ? html`<div class="jmenu" onClick=${() => setLeaveAsk(null)}>
                              <div class="jmenu-panel" onClick=${(e) => e.stopPropagation()}>
                                  <div class="jmenu-title">leave this game?</div>
                                  <div class=${`jopt ${leaveAsk.sel === 0 ? "sel" : ""}`}
                                      onClick=${doLeave}>
                                      <span>Leave</span>
                                      <span class="jopt-sub">run ends</span>
                                  </div>
                                  <div class=${`jopt ${leaveAsk.sel === 1 ? "sel" : ""}`}
                                      onClick=${() => setLeaveAsk(null)}>
                                      <span>Stay</span>
                                  </div>
                              </div>
                          </div>`
                        : ""}
                </div>
            </div>
            <${ControlDeck} onHome=${requestLeave} />
        </div>
    </main>`;
}

// Screen router — the library, or the session this device is viewing.
function Screen({ state, view, setView, refetch }) {
    if (view.screen === "library") {
        return html`<${LibraryScreen}
            state=${state}
            setView=${setView}
            refetch=${refetch}
        />`;
    }
    const session = (state.sessions || []).find(
        (s) => s.session_id === view.session_id,
    );
    if (!session) return html`<div class="boot">…</div>`; // Device bounces home
    if (session.phase === "lobby")
        return html`<${LobbyScreen}
            session=${session}
            state=${state}
            refetch=${refetch}
        />`;
    if (session.phase === "playing")
        return html`<${PlayingScreen}
            session=${session}
            refetch=${refetch}
        />`;
    if (session.phase === "results")
        return html`<${ResultsScreen}
            session=${session}
            state=${state}
            refetch=${refetch}
        />`;
    return html`<div class="boot">…</div>`; // unknown phase — bad worker data
}


// ---------------------------------------------------------------------------
// LibraryScreen — the console's home. Every game row shows who's around: avatar
// chips + a status badge when sessions are live. Picking a badged game opens a
// small join menu (join a lobby / watch a live game / start your own lobby) —
// multiplayer is opt-in, nobody is pulled anywhere.
// ---------------------------------------------------------------------------
function LibraryScreen({ state, setView, refetch }) {
    const sessions = state.sessions || [];
    const [sel, setSel] = useState(0);
    const [menu, setMenu] = useState(null); // { game, sel }

    const sessionsFor = (gid) =>
        sessions.filter((s) => s.game_id === gid);
    const hostName = (s) => {
        const h = s.seats[0];
        return h ? h.initials || h.display_name || "?" : "?";
    };
    const sessionLabel = (s) =>
        s.phase === "lobby"
            ? `${hostName(s)} · lobby ${s.seats.length}/6`
            : s.phase === "playing"
              ? `${hostName(s)} · live`
              : `${hostName(s)} · results`;
    const enter = (sid) =>
        setView({ screen: "session", session_id: sid });

    const newLobby = useCallback(
        async (game) => {
            try {
                const r = await act("api/create_session", {
                    game_id: game.id,
                    display_name: state.me.user_name || "",
                });
                if (r && r.session_id) enter(r.session_id);
            } catch (e) {}
            refetch();
        },
        [state.me, refetch],
    );

    const joinSession = useCallback(
        async (s) => {
            if (s.phase === "lobby") {
                try {
                    await act("api/claim", {
                        session_id: s.session_id,
                        display_name: state.me.user_name || "",
                    });
                } catch (e) {}
            }
            enter(s.session_id); // playing/results → watch
            refetch();
        },
        [state.me, refetch],
    );

    const choose = (game) => {
        if (!game || !game.available) return;
        const ss = sessionsFor(game.id);
        if (!ss.length) {
            newLobby(game);
            return;
        }
        setMenu({ game, sel: 0 });
    };

    // The join menu's options are recomputed live so it tracks session changes.
    const menuOptions = menu
        ? [
              ...sessionsFor(menu.game.id).map((s) => ({
                  kind: "join",
                  s,
              })),
              { kind: "new" },
          ]
        : [];
    const menuSel = menu
        ? Math.min(menu.sel, menuOptions.length - 1)
        : 0;
    const pick = (opt) => {
        setMenu(null);
        if (!opt) return;
        if (opt.kind === "new") newLobby(menu.game);
        else joinSession(opt.s);
    };

    useInput((name, edge) => {
        if (edge !== "down") return;
        if (menu) {
            if (name === "A") {
                pick(menuOptions[menuSel]);
                return;
            }
            if (name === "B") {
                setMenu(null);
                return;
            }
            if (name === "up")
                setMenu((m) => ({
                    ...m,
                    sel: Math.max(0, menuSel - 1),
                }));
            else if (name === "down")
                setMenu((m) => ({
                    ...m,
                    sel: Math.min(
                        menuOptions.length - 1,
                        menuSel + 1,
                    ),
                }));
            return;
        }
        if (name === "A") {
            choose(GAMES[sel]);
            return;
        }
        // list when narrow, 4-col grid when wide — move focus the way it looks
        setSel((s) =>
            gridMove(s, name, GAMES.length, isWide() ? 4 : 1),
        );
    });

    const av = (seat, i) =>
        html`<span key=${i} class="av"
            >${(seat.initials || seat.display_name || "?")[0]}</span
        >`;

    return html` <div class="library">
        <div class="cartridges">
            ${GAMES.map((g, i) => {
                const ss = sessionsFor(g.id);
                const players = ss.flatMap((s) => s.seats);
                const live = ss.some((s) => s.phase === "playing");
                return html` <div
                    key=${g.id}
                    class=${`cart ${i === sel ? "sel" : ""} ${g.available ? "" : "soon"}`}
                    onClick=${() => {
                        setSel(i);
                        choose(g);
                    }}
                >
                    <i class=${`game-ic ph-light ph-${g.icon}`}></i>
                    <div class="cart-title">${g.title}</div>
                    ${ss.length
                        ? html` <span class="cart-avs"
                                  >${players
                                      .slice(0, 4)
                                      .map(av)}</span
                              >
                              <span
                                  class=${`cart-live ${live ? "on" : ""}`}
                                  >${live ? "live" : "lobby"}</span
                              >`
                        : html` <div class="cart-status">
                              ${g.available
                                  ? html`<i
                                        class="cart-caret ph-light ph-caret-right"
                                    ></i>`
                                  : html`<i
                                            class="ph-light ph-lock-simple"
                                        ></i
                                        >soon`}
                          </div>`}
                </div>`;
            })}
        </div>
        ${menu
            ? html` <div
                  class="jmenu"
                  onClick=${() => setMenu(null)}
              >
                  <div
                      class="jmenu-panel"
                      onClick=${(e) => e.stopPropagation()}
                  >
                      <div class="jmenu-title">
                          ${menu.game.title}
                      </div>
                      ${menuOptions.map(
                          (opt, i) =>
                              html` <div
                                  key=${i}
                                  class=${`jopt ${i === menuSel ? "sel" : ""}`}
                                  onClick=${() => pick(opt)}
                              >
                                  <span
                                      >${opt.kind === "new"
                                          ? "Start new lobby"
                                          : sessionLabel(
                                                opt.s,
                                            )}</span
                                  >
                                  <span class="jopt-sub"
                                      >${opt.kind === "new"
                                          ? ""
                                          : opt.s.phase === "lobby"
                                            ? "join"
                                            : "watch"}</span
                                  >
                              </div>`,
                      )}
                  </div>
              </div>`
            : ""}
    </div>`;
}

// ---------------------------------------------------------------------------
// LobbyScreen — one session's seats. O = the screen's single CTA: the host
// starts, anyone without a seat joins, a seated guest waits. Leaving is the
// I / library key (Device); the last player out ends the session.
// ---------------------------------------------------------------------------
function LobbyScreen({ session, state, refetch }) {
    const seats = session.seats;
    const meId = CLIENT_ID;
    const mySeat = seats.find((s) => s.client_id === meId);
    const hostNo = seats.length ? seats[0].seat_no : null;
    const isHost = seats.length > 0 && seats[0].client_id === meId;
    const game = gameById(session.game_id) || GAMES[0];
    const sid = session.session_id;

    const join = useCallback(async () => {
        try {
            await act("api/claim", {
                session_id: sid,
                display_name: state.me.user_name || "",
            });
        } catch (e) {}
        refetch();
    }, [sid, state.me, refetch]);
    const leave = useCallback(async () => {
        try {
            await act("api/leave");
        } catch (e) {}
        refetch();
    }, [refetch]);
    const start = useCallback(async () => {
        try {
            await act("api/start", { session_id: sid });
        } catch (e) {}
        refetch();
    }, [sid, refetch]);

    const primary = isHost ? start : !mySeat ? join : null;
    useInput((name, edge) => {
        if (edge === "down" && name === "A" && primary) primary();
    });

    return html` <div class="lobby">
        <div class="lobby-title">
            <i class=${`ph-light ph-${game.icon}`}></i>${game.title}
        </div>
        <div class="seats">
            ${Array.from({ length: 6 }, (_, i) => {
                const seat = seats.find((s) => s.seat_no === i + 1);
                const mine = seat && seat.client_id === meId;
                return html` <div
                    key=${i}
                    class=${`seat ${seat ? "filled" : ""} ${mine ? "mine" : ""}`}
                    onClick=${mine ? leave : undefined}
                    title=${mine ? "Leave seat" : ""}
                >
                    <span class="seat-no">${i + 1}</span>
                    ${seat
                        ? html`<span class="seat-name"
                              ><i class="ph-light ph-user"></i>
                              ${seat.initials ||
                              seat.display_name}</span
                          >`
                        : html`<span class="seat-empty"
                              >open</span
                          >`}
                    ${seat && seat.seat_no === hostNo
                        ? html`<span class="seat-host" title="Host"
                              ><i
                                  class="ph-light ph-crown-simple"
                              ></i
                          ></span>`
                        : ""}
                </div>`;
            })}
        </div>
        <div class="lobby-foot">
            ${primary
                ? html`<button
                      class="btn primary cta"
                      onClick=${primary}
                  >
                      <i class="ph-light ph-circle"></i>${isHost
                          ? "Start"
                          : "Join"}
                  </button>`
                : html`<span class="lobby-wait"
                      >waiting for host</span
                  >`}
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// PlayingScreen — generic turn/race shell: HUD around the active game's own
// screen, keyed by round so it persists across turns. Everything game-specific
// happens inside game.screen via the ctx it receives (see games/README.md).
// ---------------------------------------------------------------------------
function PlayingScreen({ session, refetch }) {
    const { seats, turns, racers } = session;
    const game = gameById(session.game_id);
    const isRace = game && game.mode === "race";
    const sid = session.session_id;
    const ti = session.turn_index || 0;
    const nSeats = seats.length || 1;
    const attempt = Math.floor(ti / nSeats);
    const active =
        !isRace && game && attempt < game.attempts && seats.length
            ? seats[ti % nSeats]
            : null;
    const isMyTurn = !!(active && active.client_id === CLIENT_ID);
    const mySeat =
        seats.find((s) => s.client_id === CLIENT_ID) || null;
    const myFinished = turns.some((t) => t.client_id === CLIENT_ID);

    const turnLabel = isRace
        ? !mySeat
            ? "watching the race"
            : myFinished
              ? "waiting for the field"
              : "GO"
        : active
          ? isMyTurn
              ? "YOUR TURN"
              : `watching ${active.display_name}`
          : "round complete";

    // Race safety net: finished players and spectators heartbeat so the worker
    // can force-resolve a race whose stragglers stopped submitting.
    useEffect(() => {
        if (!isRace || (mySeat && !myFinished)) return;
        const id = setInterval(() => {
            act("api/beacon", { session_id: sid }).catch(() => {});
        }, 2500);
        return () => clearInterval(id);
    }, [isRace, sid, !!mySeat, myFinished]);

    if (!game || !game.screen)
        return html`<div class="boot">unknown game</div>`;

    const ctx = {
        clientId: CLIENT_ID,
        seed: session.seed || 0,
        seats,
        turns,
        turnIndex: ti,
        attempt,
        attempts: game.attempts,
        isMyTurn: isRace ? !!mySeat && !myFinished : isMyTurn,
        // race extras
        mode: game.mode || "turns",
        mySeat,
        myFinished,
        racers: racers || [],
        beacon: (data) =>
            act("api/beacon", { session_id: sid, ...data }).catch(
                () => {},
            ),
        submit: async (payload) => {
            try {
                await act("api/turn", { session_id: sid, payload });
            } catch (e) {}
            refetch();
        },
    };

    return html` <div class="playing">
        <div class="hud">
            <span
                class=${`turn ${(isRace ? mySeat && !myFinished : isMyTurn) ? "you" : ""}`}
                >${turnLabel}</span
            >
            ${!isRace && game.attempts > 1
                ? html`<span class="attempt-dots">
                      ${Array.from(
                          { length: game.attempts },
                          (_, i) =>
                              html`<span
                                  key=${i}
                                  class=${`adot ${i < attempt ? "used" : i === attempt ? "now" : ""}`}
                              ></span>`,
                      )}
                  </span>`
                : ""}
            ${isRace
                ? html`<span class="turn"
                      >${turns.length}/${seats.length} home</span
                  >`
                : ""}
        </div>
        <${game.screen}
            key=${`round-${session.round_id}`}
            ctx=${ctx}
        />
    </div>`;
}

// ---------------------------------------------------------------------------
// ResultsScreen — one session's round ranking (trophy on the winner), initials
// entry if you placed, that game's global leaderboard, and Play again (host).
// ---------------------------------------------------------------------------
function ResultsScreen({ session, state, refetch }) {
    const { seats, turns } = session;
    const game = gameById(session.game_id) || GAMES[0];
    const sid = session.session_id;
    const meId = CLIENT_ID;
    const isHost = seats.length > 0 && seats[0].client_id === meId;
    const mySeat = seats.find((s) => s.client_id === meId);

    // Rank by each player's BEST turn of the round (same rule the worker uses
    // for the leaderboard). Game specifics live in the turn's summary string.
    const best = new Map();
    for (const t of turns) {
        const cur = best.get(t.seat_no);
        if (!cur || t.points > cur.points) best.set(t.seat_no, t);
    }
    const myBest = mySeat ? best.get(mySeat.seat_no) : null;
    const needInitials =
        myBest && myBest.points > 0 && mySeat && !mySeat.initials;

    // Seats with no turn at all (race DNFs) still appear, at the bottom.
    for (const s of seats) {
        if (!best.has(s.seat_no))
            best.set(s.seat_no, {
                seat_no: s.seat_no,
                points: 0,
                summary: "DNF",
            });
    }
    const ranking = [...best.values()]
        .map((t) => ({
            t,
            seat: seats.find((s) => s.seat_no === t.seat_no),
        }))
        .sort(
            (a, b) =>
                b.t.points - a.t.points ||
                a.t.seat_no - b.t.seat_no,
        );

    const lbRows = (state.leaderboard || [])
        .filter((r) => r.game_id === game.id)
        .slice(0, 10);

    const playAgain = useCallback(async () => {
        try {
            await act("api/next", { session_id: sid });
        } catch (e) {}
        refetch();
    }, [sid, refetch]);

    // O = Play again for the host (once initials are in). While initials are still
    // needed, InitialsEntry owns O to submit; back to the library is I / the button.
    useInput((name, edge) => {
        if (edge !== "down" || name !== "A") return;
        if (!needInitials && isHost) playAgain();
    });

    return html` <div class="results">
        <div class="lobby-title">Results</div>
        <div class="ranking">
            ${ranking.map(
                ({ t, seat }, i) =>
                    html` <div
                        class=${`rank ${i === 0 && t.points > 0 ? "win" : ""}`}
                        key=${t.seat_no}
                    >
                        <span class="rank-pos">
                            ${i === 0 && t.points > 0
                                ? html`<i
                                      class="ph-light ph-trophy"
                                  ></i>`
                                : `#${i + 1}`}
                        </span>
                        <span class="rank-name"
                            >${seat
                                ? seat.initials || seat.display_name
                                : "—"}</span
                        >
                        <span class="rank-sum"
                            >${t.summary || ""}</span
                        >
                        <span class="rank-pts">${t.points}</span>
                    </div>`,
            )}
        </div>
        ${needInitials
            ? html`<${InitialsEntry}
                  gameId=${game.id}
                  refetch=${refetch}
              />`
            : ""}
        <${Leaderboard} rows=${lbRows} />
        <div class="results-actions">
            ${isHost
                ? html`<button
                      class="btn primary cta"
                      onClick=${playAgain}
                  >
                      ${needInitials
                          ? ""
                          : html`<i
                                class="ph-light ph-circle"
                            ></i>`}Play
                      again
                  </button>`
                : ""}
        </div>
    </div>`;
}

// Arcade initials: prefilled + auto-submitted for returning players (per-device).
function InitialsEntry({ gameId, refetch }) {
    const [val, setVal] = useState("");
    const submitted = useRef(false);

    const submit = useCallback(
        async (v) => {
            const initials = (v || "")
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 3);
            if (!initials || submitted.current) return;
            submitted.current = true;
            await frame.localStorageSetItem("initials", initials);
            await act("api/initials", {
                initials,
                game_id: gameId,
            });
            refetch();
        },
        [gameId, refetch],
    );

    useEffect(() => {
        frame.localStorageGetItem("initials").then((saved) => {
            if (saved) {
                setVal(saved);
                submit(saved);
            }
        });
    }, []);

    useInput((name, edge) => {
        if (edge === "down" && name === "A") submit(val);
    });

    return html` <div class="initials">
        <span class="initials-label">ENTER INITIALS</span>
        <input
            class="initials-input"
            maxlength="3"
            autocapitalize="characters"
            value=${val}
            onInput=${(e) => setVal(e.target.value.toUpperCase())}
            onKeyDown=${(e) => {
                if (e.key === "Enter") submit(val);
            }}
            placeholder="AAA"
        />
        <button class="btn primary" onClick=${() => submit(val)}>
            OK
        </button>
    </div>`;
}

function Leaderboard({ rows }) {
    return html` <div class="lb">
        <div class="lb-title">LEADERBOARD</div>
        ${!rows || rows.length === 0
            ? html`<div class="lb-empty">no scores yet</div>`
            : rows.map(
                  (r, i) =>
                      html` <div
                          class="lb-row"
                          key=${r._row_id || i}
                      >
                          <span class="lb-rank">${i + 1}</span>
                          <span class="lb-init">${r.initials}</span>
                          <span class="lb-pts">${r.points}</span>
                      </div>`,
              )}
    </div>`;
}

render(html`<${App} />`, document.getElementById("root"));
