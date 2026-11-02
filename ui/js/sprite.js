/* Codex pet sprites, 1:1 with the Codex desktop app (26.1027): sheet formats, animation rows, frame timing,
   playback and look directions.
   - A sheet is 8 columns of 192×208 cells. v1 is 1536×1872 (9 rows), v2 is 1536×2288 (11 rows: rows 9–10 are
     16 look directions, 22.5° apart, clockwise from straight up; row 9 holds directions 0–7, row 10 holds 8–15).
   - Rows: 0 idle · 1 running-right · 2 running-left · 3 waving · 4 jumping · 5 failed · 6 waiting · 7 running · 8 review.
   - Timing: idle [280,110,110,140,140,320] ms; every other state one duration per frame and a longer last frame.
   - Playback: idle loops at one sixth speed. Any other state plays its row three times, then settles into that
     slow idle. Hover shows "jumping"; dragging shows running-left/right; reduced motion shows frame 0 only.
   - Drawn as a div with the sheet as background (800% × rows·100%), stepped by background-position, pixelated.
   Companion extensions Codex ignores: pet.json "rowFrames" (frames per row, the community editors' key) and
   "claudeCompanion": {"timing": {state: [ms, …]}} (per-frame ms as they play; idle without the ×6). */
(function () {
  const CC = (window.CC = window.CC || {});
  const CELL_W = 192, CELL_H = 208, COLS = 8;
  const FORMATS = [
    { version: 1, width: 1536, height: 1872, rows: 9, required: [6, 8, 8, 4, 5, 8, 6, 6, 6] },
    { version: 2, width: 1536, height: 2288, rows: 11, required: [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] },
  ];
  const IDLE_MS = [280, 110, 110, 140, 140, 320];
  const IDLE_SLOW = 6;
  // state → [row, frames, ms, last-frame ms]
  const STATES = {
    idle: [0, 6],
    "running-right": [1, 8, 120, 220],
    "running-left": [2, 8, 120, 220],
    waving: [3, 4, 140, 280],
    jumping: [4, 5, 140, 280],
    failed: [5, 8, 140, 240],
    waiting: [6, 6, 150, 260],
    running: [7, 6, 120, 220],
    review: [8, 6, 150, 280],
  };
  const ROWS = [
    { key: "idle", label: "Idle", note: "Resting; plays at one sixth speed between states" },
    { key: "running-right", label: "Run right", note: "Dragged to the right" },
    { key: "running-left", label: "Run left", note: "Dragged to the left" },
    { key: "waving", label: "Waving", note: "Says hello when the app starts" },
    { key: "jumping", label: "Jumping", note: "The cursor is on the pet" },
    { key: "failed", label: "Failed", note: "A session is blocked" },
    { key: "waiting", label: "Waiting", note: "A session needs your input" },
    { key: "running", label: "Running", note: "Claude is working" },
    { key: "review", label: "Review", note: "A session is ready for you" },
    { key: "look-a", label: "Look up → right → down", note: "v2: directions 1–8, clockwise from up" },
    { key: "look-b", label: "Look down → left → up", note: "v2: directions 9–16" },
  ];

  const formatFor = (w, h) => FORMATS.find((f) => f.width === w && f.height === h) || null;
  const stateRow = (state) => (STATES[state] || STATES.idle)[0];

  /* A pet as the player needs it, from pets.rs PetInfo. */
  function model(info) {
    const fmt = formatFor(info.width, info.height);
    const rows = fmt ? fmt.rows : Math.max(1, Math.round((info.height || CELL_H * 9) / CELL_H));
    const m = info.manifest || {};
    return {
      id: info.id, name: info.displayName || info.id, description: info.description || "",
      url: CC.petUrl(info.id, info.sheet, info.stamp), sheet: info.sheet, width: info.width, height: info.height,
      fmt, rows, version: fmt ? fmt.version : rows >= 11 ? 2 : 1, valid: !!fmt,
      rowFrames: Array.isArray(m.rowFrames) ? m.rowFrames.slice() : null,
      timing: (m.claudeCompanion && m.claudeCompanion.timing) || null,
      manifest: m, info,
    };
  }

  function frameCount(pet, row) {
    const def = (pet && pet.fmt ? pet.fmt.required : FORMATS[1].required)[row] || COLS;
    const rf = pet && pet.rowFrames && pet.rowFrames[row];
    return Math.max(1, Math.min(COLS, Number.isFinite(rf) && rf > 0 ? rf : def));
  }

  /* Codex's default ms for frame c of a state with n frames (idle as it plays: ×6). */
  function defaultMs(state, c, n) {
    if (state === "idle") return (IDLE_MS[c] != null ? IDLE_MS[c] : IDLE_MS[IDLE_MS.length - 1]) * IDLE_SLOW;
    const s = STATES[state];
    return c === n - 1 ? s[3] : s[2];
  }

  /* The frames of one state: [{row, col, ms}]. */
  function frames(state, pet) {
    const row = stateRow(state), n = frameCount(pet, row);
    const custom = pet && pet.timing && Array.isArray(pet.timing[state]) ? pet.timing[state] : null;
    const out = [];
    for (let c = 0; c < n; c++) {
      const ms = custom && Number.isFinite(custom[c]) && custom[c] > 0 ? custom[c] : defaultMs(state, c, n);
      out.push({ row, col: c, ms });
    }
    return out;
  }

  /* Codex's playback list: idle loops; others ×3 then the slow idle loop (or loop forever with `loop`). */
  function timeline(state, pet, opt = {}) {
    const r = frames(state, pet);
    if (opt.reduced) return { frames: [r[0]], loopStart: null };
    if (state === "idle") return { frames: r, loopStart: 0 };
    if (opt.loop) return { frames: r, loopStart: 0 };
    const idle = frames("idle", pet), three = [...r, ...r, ...r];
    return { frames: [...three, ...idle], loopStart: three.length };
  }

  /* v2 only: the look frame toward a point (both in the same coordinates); null within 1 px of the centre. */
  function lookFrame(rect, point, version) {
    if (version !== 2) return null;
    const dx = point.x - (rect.left + rect.width / 2), dy = point.y - (rect.top + rect.height / 2);
    if (Math.hypot(dx, dy) <= 1) return null;
    const a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const o = Math.round(a / 22.5) % 16;
    return { row: 9 + Math.floor(o / 8), col: o % 8, ms: 0 };
  }

  const position = (f, rows) => `${(f.col / (COLS - 1)) * 100}% ${rows > 1 ? (f.row / (rows - 1)) * 100 : 0}%`;
  const reducedMQ = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)");

  /* Plays a pet on an element, exactly like Codex's sprite component (setTimeout per frame). */
  class Player {
    constructor(el) {
      this.el = el; this.pet = null; this.state = "idle"; this.loop = false; this.look = null; this.timer = null; this.paused = false;
      el.classList.add("sprite");
    }
    setPet(pet) {
      this.pet = pet;
      if (!pet) { this.el.style.backgroundImage = ""; this.stop(); return; }
      this.el.style.backgroundImage = `url("${pet.url}")`;
      this.el.style.backgroundSize = `${COLS * 100}% ${pet.rows * 100}%`;
      this.restart();
    }
    play(state, opt = {}) {
      const loop = !!opt.loop;
      if (state === this.state && loop === this.loop && !opt.force) return;
      this.state = state; this.loop = loop;
      this.restart();
    }
    setLook(f) {
      const same = (a, b) => (a && b ? a.row === b.row && a.col === b.col : a === b);
      if (same(f, this.look)) return;
      const had = !!this.look;
      this.look = f;
      if (f) { this.stop(); this.show(f); } else if (had) this.restart();
    }
    show(f) { if (this.pet) this.el.style.backgroundPosition = position(f, this.pet.rows); }
    stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
    restart() {
      this.stop();
      if (!this.pet) return;
      if (this.look) { this.show(this.look); return; }
      const t = timeline(this.state, this.pet, { loop: this.loop, reduced: reducedMQ && reducedMQ.matches });
      const fr = t.frames;
      let i = 0;
      this.show(fr[0]);
      this.frame = fr[0];
      if (fr.length === 1 || this.paused) return;
      const step = () => {
        this.timer = setTimeout(() => {
          let n = i + 1;
          if (n >= fr.length) { if (t.loopStart == null) { this.timer = null; return; } n = t.loopStart; }
          i = n; this.frame = fr[i]; this.show(fr[i]); step();
        }, fr[i].ms);
      };
      step();
    }
  }

  CC.sprite = { CELL_W, CELL_H, COLS, FORMATS, STATES, ROWS, IDLE_MS, IDLE_SLOW, formatFor, model, frameCount, defaultMs, frames, timeline, lookFrame, position, Player, stateRow };
})();
