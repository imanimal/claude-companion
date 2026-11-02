/* The pet overlay window. Rust (overlay.rs) keeps it on top and click-through outside the rects this file
   reports, follows the cursor while dragging and streams the cursor position; this file owns the layout.
   Layout: the window is bigger than the pet. Where the pet sits on its monitor picks the placement, like
   Codex's top-/bottom-start/end: in the upper part of the screen the pills hang below it, otherwise they
   stack above; on the right half they align to the pet's right edge and grow left, on the left half the
   reverse. The pet's screen spot (settings petX/petY, physical px) is fixed; the window moves around it.
   Several chats make a deck: the front pill is a chat that needs you, else the one closest to completion
   (sessions.rs orders the list),
   with up to two more peeking out behind it on the side away from the pet; finished chats sit at the back,
   tinted and labelled Done. Collegiapp countdowns (collegiapp.rs: a class from an hour out, work from a day out) always queue
   behind the chats, so they're in front only while Claude has nothing to show; their clocks tick here every second.
   While the pills are hidden, a bell with the number of chats brings them back. Hovering the deck fans it out into
   every chat that fits; clicking the pet pins that open. Sprite state follows the most urgent session
   (waiting > failed > review > running > idle); hover jumps, dragging runs left/right (with the pills trailing
   on a spring, and pets set to tilt leaning into it), v2 pets look toward a nearby cursor, the app says hello
   with a wave. The pills wear the theme in use, the night theme too (themes.js pills()). Its size is a share of
   Codex's (petScale: Settings' slider, the Size menu, Ctrl-scroll or a pinch over the pet). */
(function () {
  const { $, esc, ic, invoke, on, sprite } = CC, TH = CC.themes;
  // Codex draws the pet 7.04rem wide; petScale sizes it from half that to twice
  const CODEX_W = 112.64, MIN_SCALE = 0.5, MAX_SCALE = 2;
  const scaleOf = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s && s.petScale) || 1));
  // PAD is the clear room round the window's parts the pills can swing into while dragged; KEYS is the band
  // the hover keys pop out into, under the pet (over its head when the pills hang below)
  const PAD = 30, GAP = 6, KEYS = 38, PILL_W = 300, STACK_H = 360;
  const PRIO = { waiting: 0, failed: 1, review: 2, running: 3, idle: 4 };
  const STAT = {
    running: { icon: "spin", label: "", sprite: "running" },
    waiting: { icon: "warn", label: "Needs input", sprite: "waiting" },
    failed: { icon: "warn", label: "Blocked", sprite: "failed" },
    review: { icon: "okc", label: "Done", sprite: "review" },
    idle: { icon: "clock", label: "", sprite: "idle" },
  };
  // Collegiapp kinds: icon and label (anything else is work: "Due"); course colours are pet.css's --k1–--k6
  const KINDS = {
    class: ["classes", "Class"], office_hours: ["classes", "Office hours"], event: ["events", "Event"], ticket: ["ticket", "Ticket"],
    exam: ["exams", "Exam"], quiz: ["exams", "Quiz"], lab: ["lab", "Due"],
  };

  const elPet = $("#pet"), elSprite = $("#sprite"), elStack = $("#stack"), elBadge = $("#badge"), elTools = $("#tools");
  const player = new sprite.Player(elSprite);
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  /* A quick squash and stretch from the feet whenever the art moves to another animation, so a switch reads as
     the pet changing pose rather than a cut. Also on coming out of a v2 look (rows 9–10), even back to the pose it
     had, but not going into one or between look turns. Not between frames of one animation, and not twice within
     200 ms (a drag that keeps changing direction). */
  const POP = [{ transform: "none" }, { transform: "scale(1.07, .93)", offset: 0.3 }, { transform: "scale(.97, 1.05)", offset: 0.65 }, { transform: "none" }];
  let poseRow = null, lastPop = 0;
  player.onRow = (row, was) => {
    const back = was >= 9;
    if (row >= 9 || (row === poseRow && !back)) return;
    const first = poseRow == null && !back;
    poseRow = row;
    if (first || calm.matches || performance.now() - lastPop < 200) return;
    lastPop = performance.now();
    elSprite.animate(POP, { duration: 260, easing: "ease-out" });
  };
  let S = null, pet = null, sessions = [], countdowns = [], shown = [];
  let dims = { S: CODEX_W, SH: CODEX_W * 208 / 192, W: 0, H: 0 };
  let place = { v: "above", h: "end" }, scale = 1;
  let expanded = false, folded = false, fan = false, fanTimer = null, hoverPet = false, transient = null, drag = null;
  let awakeUntil = Date.now() + 2300, lastPulse = 0, lastTop = "", sentRects = "";

  // render() keeps the fold key's icon and title current
  const drawTools = () => {
    elTools.innerHTML = `<button data-act="edit" title="Edit this pet" aria-label="Edit this pet">${ic("edit")}</button>` +
      `<button data-act="claude" title="Open Claude" aria-label="Open Claude">${ic("claude")}</button>` +
      `<button data-act="fold" title="Show or hide updates" aria-label="Show or hide updates">${ic("chev")}</button>` +
      `<span class="sep"></span><button data-act="app" title="Open Claude Companion" aria-label="Open Claude Companion">${ic("paw")}</button>`;
  };
  drawTools();

  /* ───────── geometry ───────── */
  function computeDims() {
    const s = CODEX_W * scaleOf(S), sh = (s * 208) / 192;
    dims = { S: s, SH: sh, W: Math.ceil(Math.max(PILL_W, s) + 2 * PAD), H: Math.ceil(sh + GAP + STACK_H + KEYS + 2 * PAD) };
    document.documentElement.style.setProperty("--pw", s + "px");
  }
  const petOffset = () => ({ x: place.h === "end" ? dims.W - PAD - dims.S : PAD, y: place.v === "above" ? dims.H - PAD - KEYS - dims.SH : PAD + KEYS });
  const monitorAt = (mons, x, y) => mons.find((m) => x >= m[0] && y >= m[1] && x < m[0] + m[2] && y < m[1] + m[3]);

  async function placeWindow(save) {
    let info;
    try { info = await invoke("overlay_info"); } catch (e) { return; }
    scale = info.scale || 1;
    const pw = dims.S * scale, ph = dims.SH * scale;
    let px = S.petX, py = S.petY;
    if (px == null || py == null) {
      const m = monitorAt(info.monitors, info.x + 10, info.y + 10) || info.monitors[0] || [0, 0, 1280, 720];
      px = m[0] + m[2] - pw - 28 * scale; py = m[1] + m[3] - ph - KEYS * scale;
    }
    const mon = monitorAt(info.monitors, px + pw / 2, py + ph / 2) || info.monitors[0] || [0, 0, 1280, 720];
    // the pet keeps the keys' band on screen above and below it
    px = Math.min(Math.max(px, mon[0]), mon[0] + mon[2] - pw);
    py = Math.min(Math.max(py, mon[1] + KEYS * scale), mon[1] + mon[3] - ph - KEYS * scale);
    place = { v: py + ph / 2 - mon[1] < mon[3] * 0.45 ? "below" : "above", h: px + pw / 2 - mon[0] > mon[2] / 2 ? "end" : "start" };
    const off = petOffset();
    await invoke("overlay_set", { x: Math.round(px - off.x * scale), y: Math.round(py - off.y * scale), width: dims.W, height: dims.H }).catch(() => {});
    layout();
    if (save) { S.petX = px; S.petY = py; invoke("set_settings", { patch: { petX: px, petY: py } }).catch(() => {}); }
    // a move onto a monitor with another scale resizes the window; place once more with the new scale
    const after = await invoke("overlay_info").catch(() => null);
    if (after && Math.abs((after.scale || 1) - scale) > 0.01) { scale = after.scale; return placeWindow(save); }
  }

  function layout() {
    const off = petOffset();
    Object.assign(elPet.style, { left: off.x + "px", top: off.y + "px" });
    elStack.className = `stack ${place.v} ${place.h}`;
    elPet.classList.toggle("keys-up", place.v === "below");
    Object.assign(elStack.style, {
      width: dims.W - 2 * PAD + "px", maxHeight: STACK_H + "px", left: PAD + "px",
      top: place.v === "below" ? off.y + dims.SH + GAP + "px" : "", bottom: place.v === "above" ? dims.H - off.y + GAP + "px" : "",
    });
    requestAnimationFrame(sendRects);
  }

  /* only the pet, its keys (while they're out) and the pills take clicks; everything else falls through to the
     desktop. The keys stay laid out to animate, so they count only while the pet is hovered. */
  const keysOut = () => hoverPet && !drag;
  function sendRects() {
    const parts = [elPet, elBadge, ...elStack.querySelectorAll(".pill, .layer, .more")].concat(keysOut() ? [elTools] : []);
    const rects = parts.filter((e) => e.offsetParent !== null || e === elPet).map((e) => {
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    });
    const k = JSON.stringify(rects);
    if (k !== sentRects) { sentRects = k; invoke("set_hit_rects", { rects }).catch(() => {}); }
  }

  /* ───────── sprite state ───────── */
  const urgent = () => sessions.reduce((a, s) => (!a || PRIO[s.status] < PRIO[a.status] ? s : a), null);
  function baseState() {
    if (Date.now() < awakeUntil) return "waving";
    const u = urgent();
    return u ? STAT[u.status].sprite : "idle";
  }
  function updateSprite() {
    const st = transient || (hoverPet && S && S.hoverJump ? "jumping" : baseState());
    player.play(st);
  }
  setTimeout(updateSprite, 2400);

  /* ───────── pills ───────── */
  const behindHtml = (n) => (n ? `<span class="nn" title="${n} more">+${n}</span>` : "");

  function pillHtml(s, exp, behind) {
    const st = STAT[s.status] || STAT.idle;
    const pct = s.status !== "review" && s.status !== "idle" && s.progress != null ? s.progress : null;
    let sub = s.subtitle || (s.status === "running" ? "Thinking" : "");
    if (!exp && s.step && (sub === "Thinking" || !sub)) sub = s.step;
    // chats the desktop app started open there (open_chat); terminal chats just open the app
    const act = s.id === "_idle" ? "" : s.hostSession ? "Click to open this chat in Claude" : "Click to open Claude";
    const tip = [s.title, s.step, s.subtitle, s.cwd, act].filter(Boolean).join("\n");
    return `<div class="pill s-${s.status}${exp ? " exp" : ""}" data-id="${esc(s.id)}" title="${esc(tip)}">` +
      `<span class="st">${ic(st.icon)}</span>` +
      `<span class="tx"><span class="t1"><b class="ti">${esc(s.title || "Claude")}</b>${st.label ? `<span class="lb">${st.label}</span>` : ""}` +
      behindHtml(behind) + `</span>` +
      (exp && s.step ? `<span class="t3">${esc(s.step)}</span>` : "") +
      `<span class="t2">${esc(sub)}</span></span>` +
      (pct != null ? `<span class="pc">${pct}<small>%</small></span><i class="bar"><i style="width:${pct}%"></i></i>` : "") +
      (s.status !== "running" && s.id !== "_idle" ? `<button class="x" data-x="${esc(s.id)}" title="Dismiss" aria-label="Dismiss">${ic("close")}</button>` : "") +
      `</div>`;
  }

  /* Countdowns: phase next → soon (10 min before a class, an hour before a deadline) → live (on, counting to its
     end) or now (zero, until Rust drops it); a class that has ended is hidden at once. The progress line fills from when the pill appeared to the start,
     then through the class. Clock format is Collegiapp's island: m:ss, h:mm:ss, NOW. */
  const two = (n) => String(n).padStart(2, "0");
  function clock(ms) {
    if (ms <= 0) return "NOW";
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h >= 24 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : (h ? h + ":" + two(m) : m) + ":" + two(s % 60);
  }
  const cdLive = (c, now) => c.end != null && now >= c.at && now < c.end;
  function cdPhase(c, now) {
    if (cdLive(c, now)) return "live";
    if (c.end != null && now >= c.end) return "over";
    if (now >= c.at) return "now";
    return c.at - now < (c.group === "class" ? 10 : 60) * 60000 ? "soon" : "next";
  }
  const cdClock = (c, now) => clock((cdLive(c, now) ? c.end : c.at) - now);
  function cdFrac(c, now) {
    const [a, b] = cdLive(c, now) ? [c.at, c.end] : [c.from, c.at];
    return Math.max(0, Math.min(1, (now - a) / Math.max(1, b - a)));
  }
  const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayOf = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? "Today" : "Tomorrow");
  const squash = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

  function cdHtml(c, exp, behind) {
    const now = Date.now(), ph = cdPhase(c, now);
    const [icon, name] = KINDS[c.kind] || ["work", "Due"];
    const label = ph === "live" ? (c.kind === "class" ? "In class" : "On now") : ph === "now" ? "Now" : name;
    const when = ph === "live" ? "Until " + hm(c.end) : c.group === "class" ? hm(c.at) : dayOf(c.at) + " " + hm(c.at);
    // the course code unless the title already says it ("CMPSC 130A Lecture")
    const course = c.course && !squash(c.title).includes(squash(c.course)) ? c.course : "";
    const sub = [course, c.location, when].filter(Boolean).join(" · ");
    const tip = [c.title, sub, "Click to open Collegiapp"].join("\n");
    const kc = c.color >= 1 && c.color <= 6 ? ` style="--kc:var(--k${c.color})"` : "";
    return `<div class="pill cd p-${ph}${exp ? " exp" : ""}" data-cd="${esc(c.id)}"${kc} title="${esc(tip)}">` +
      `<span class="st">${ic(icon)}</span>` +
      `<span class="tx"><span class="t1"><b class="ti">${esc(c.title)}</b><span class="lb">${label}</span>${behindHtml(behind)}</span>` +
      `<span class="t2">${esc(sub)}</span></span>` +
      `<span class="pc">${cdClock(c, now)}</span><i class="bar"><i style="width:${(cdFrac(c, now) * 100).toFixed(2)}%"></i></i>` +
      `<button class="x" data-xcd="${esc(c.key)}" title="Hide this countdown" aria-label="Hide this countdown">${ic("close")}</button></div>`;
  }

  const anyHtml = (x, exp, behind) => (countdowns.includes(x) ? cdHtml(x, exp, behind) : pillHtml(x, exp, behind));

  function render() {
    if (!S) return;
    const mode = S.pill || "auto";
    // Claude chats always come first; Collegiapp's countdowns queue behind them
    const now = Date.now(), cds = countdowns.filter((c) => cdPhase(c, now) !== "over");
    let list = sessions.concat(cds);
    shown = list;
    if (!list.length && mode === "always") list = [{ id: "_idle", status: "idle", title: "Claude is idle", subtitle: "Session updates show here" }];
    const show = mode !== "never" && !folded && list.length > 0;
    const open = show && list.length > 1 && (expanded || fan);
    if (!show) elStack.innerHTML = "";
    else if (open) {
      elStack.innerHTML = list.map((s) => anyHtml(s, expanded)).join("");
      fit(list.length);
    } else {
      const behind = Math.min(2, list.length - 1);
      elStack.innerHTML = `<div class="deck">${anyHtml(list[0], expanded, list.length - 1)}` +
        Array.from({ length: behind }, (_, i) => `<span class="layer l${i + 1}" data-open title="Show them all"></span>`).join("") + `</div>`;
    }
    // the bell counts what you can't see while the pills are hidden (with Pills set to Never, just the chats);
    // clicking it shows them
    const n = sessions.length, m = mode === "never" ? 0 : cds.length;
    elBadge.hidden = !(n + m > 0 && !show);
    if (!elBadge.hidden) {
      const u = urgent();
      const need = sessions.filter((s) => s.status === "waiting" || s.status === "failed").length;
      const working = sessions.filter((s) => s.status === "running").length;
      elBadge.innerHTML = `${ic("bell")}<b>${n + m}</b>`;
      elBadge.className = "badge" + (!u ? "" : u.status === "waiting" ? " warn" : u.status === "failed" ? " bad" : u.status === "review" ? " ok" : "");
      const parts = [n ? (n === 1 ? "1 chat" : `${n} chats`) : "", need ? `${need} need${need === 1 ? "s" : ""} you` : "", working ? `${working} working` : "",
        m ? `${m} coming up in Collegiapp` : ""].filter(Boolean);
      const tip = parts.join(", ") + (mode === "never" ? ". Click to open them in Claude Companion" : ". Click to show the updates");
      elBadge.title = tip;
      elBadge.setAttribute("aria-label", tip);
    }
    const fold = elTools.querySelector('[data-act="fold"]');
    if (fold) { const t = folded ? "Show updates" : "Hide updates"; fold.title = t; fold.setAttribute("aria-label", t); fold.innerHTML = ic(folded ? "chevu" : "chev"); }
    requestAnimationFrame(sendRects);
  }

  /* Fanned out: keeps the pills that fit the window, closest to completion first, and a count of the rest. */
  function fit(total) {
    const pills = [...elStack.querySelectorAll(".pill")];
    const over = () => elStack.scrollHeight > STACK_H + 1;
    let n = pills.length;
    while (n > 1 && over()) pills[--n].remove();
    if (n < total) {
      elStack.insertAdjacentHTML("beforeend", `<button class="more" data-app title="Open the Claude view">+${total - n} more</button>`);
      while (n > 1 && over()) { pills[--n].remove(); elStack.querySelector(".more").textContent = `+${total - n} more`; }
    }
  }

  /* Hovering the deck fans it out after a beat; leaving the pills (gaps included) folds it back. */
  function overPills(x, y, pad) {
    for (const el of elStack.querySelectorAll(".pill, .layer, .more")) {
      const r = el.getBoundingClientRect();
      if (x >= r.left - pad && x < r.right + pad && y >= r.top - pad && y < r.bottom + pad) return true;
    }
    return false;
  }
  function hoverFan(x, y) {
    const want = shown.length > 1 && !drag && overPills(x, y, fan ? GAP + 2 : 0);
    if (want === fan) { clearTimeout(fanTimer); fanTimer = null; return; }
    if (!fanTimer) fanTimer = setTimeout(() => { fanTimer = null; fan = !fan; render(); }, want ? 220 : 450);
  }

  function setSessions(list) {
    const prevAttention = new Set(sessions.filter((s) => s.status === "waiting" || s.status === "failed").map((s) => s.id));
    sessions = Array.isArray(list) ? list : [];
    // something new needs you: unfold
    if (sessions.some((s) => (s.status === "waiting" || s.status === "failed") && !prevAttention.has(s.id))) folded = false;
    // each new update on the most urgent session replays its animation (at most every 5 s), so the pet reacts to chat
    const top = urgent();
    const key = top ? top.id + "|" + top.status + "|" + top.subtitle : "";
    if (key !== lastTop) {
      lastTop = key;
      if (top && Date.now() - lastPulse > 5000 && !transient && !hoverPet) { lastPulse = Date.now(); player.play(STAT[top.status].sprite, { force: true }); }
    }
    render();
    updateSprite();
  }

  /* A countdown that shows up, or turns amber, gets a wave from the pet while no chat is showing. */
  const phaseOf = {};
  function setCountdowns(list, quiet) {
    countdowns = Array.isArray(list) ? list : [];
    const now = Date.now();
    let fresh = false;
    for (const k in phaseOf) if (!countdowns.some((c) => c.key === k)) delete phaseOf[k];
    for (const c of countdowns) if (!(c.key in phaseOf)) { phaseOf[c.key] = cdPhase(c, now); fresh = true; }
    if (fresh && !quiet) nudge();
    render();
  }
  function nudge() {
    if (!sessions.length && !transient && !hoverPet && !drag) player.play("waving", { force: true });
  }

  /* Every second: the clocks and progress lines in place; a phase change redraws the pills. */
  function tickCountdowns() {
    if (!countdowns.length || !S) return;
    const now = Date.now();
    let redraw = false, soon = false;
    for (const c of countdowns) {
      const ph = cdPhase(c, now);
      if (phaseOf[c.key] === ph) continue;
      soon = soon || ph === "soon";
      phaseOf[c.key] = ph;
      redraw = true;
    }
    if (soon) nudge();
    if (redraw) return render();
    for (const el of elStack.querySelectorAll(".pill[data-cd]")) {
      const c = countdowns.find((x) => x.id === el.dataset.cd);
      if (!c) continue;
      const pc = el.querySelector(".pc"), bar = el.querySelector(".bar i");
      if (pc) pc.textContent = cdClock(c, now);
      if (bar) bar.style.width = (cdFrac(c, now) * 100).toFixed(2) + "%";
    }
  }
  setInterval(tickCountdowns, 1000);

  /* ───────── pet + settings ───────── */
  async function loadPet() {
    let list = [];
    try { list = await invoke("list_pets"); } catch (e) { /* not running in Tauri */ }
    const info = list.find((p) => p.id === (S && S.activePet)) || list[0];
    pet = info ? sprite.model(info) : null;
    elSprite.classList.toggle("nopet", !pet);
    elSprite.innerHTML = pet ? "" : ic("paw");
    elPet.setAttribute("aria-label", pet ? pet.name : "Pet");
    player.setPet(pet);
  }

  /* The theme in use (themes.js pick: the night theme while the system is dark) as pet.css variables and
     html[data-look] and [data-scheme]; a new look redraws the icons, which differ between Pocket and Standard. */
  let painted = [];
  function paint() {
    const t = TH.pick(S), root = document.documentElement, vars = TH.pills(t), look = root.dataset.look;
    for (const v of painted) root.style.removeProperty(v);
    for (const v in vars) root.style.setProperty(v, vars[v]);
    painted = Object.keys(vars);
    root.dataset.look = t.look;
    root.dataset.scheme = t.scheme;
    root.toggleAttribute("data-claude", !!t.claude);
    if (look === t.look) return;
    drawTools();
    if (!pet) elSprite.innerHTML = ic("paw");
  }
  TH.darkMQ.addEventListener("change", () => { if (S) { paint(); render(); } });

  async function applySettings(next) {
    const first = !S;
    const sizeChanged = first || scaleOf(next) !== scaleOf(S);
    const petChanged = first || next.activePet !== S.activePet;
    // Settings' "Move to the corner" clears the saved spot
    const reset = !first && next.petX == null && S.petX != null;
    // otherwise only this window moves the pet, and an event can predate its last save
    if (!first && !reset) { next.petX = S.petX; next.petY = S.petY; }
    const was = dims;
    S = next;
    paint();
    document.body.classList.toggle("shadow", S.shadow !== false);
    document.body.classList.toggle("smooth", S.smooth !== false);
    if (sizeChanged || reset) {
      computeDims();
      // a new size keeps the pet's feet where they were, and its side toward the screen's edge (the pills' side)
      const keep = !first && !reset && S.petX != null;
      if (keep) { S.petX += (place.h === "end" ? was.S - dims.S : 0) * scale; S.petY += (was.SH - dims.SH) * scale; }
      await placeWindow(reset || keep);
    }
    if (petChanged) await loadPet();
    if (!S.look) player.setLook(null);
    render();
    updateSprite();
  }

  /* ───────── input ───────── */
  const inRect = (el, x, y, pad = 0) => {
    const r = el.getBoundingClientRect();
    return x >= r.left - pad && x < r.right + pad && y >= r.top - pad && y < r.bottom + pad;
  };
  // while the keys are out they count as the pet, along with the gap between them, so the cursor can reach them
  const inPet = (x, y) => inRect(elPet, x, y) || (hoverPet && inRect(elTools, x, y, 6));

  /* While the pet is dragged the pills ride on a spring. Rust reports the window's eased position and velocity
     ("drag-move", physical px); the stack is a mass pulled after the window in screen space, damped mostly
     against the window's own motion, so every speed-up, slow-down and turn moves it, and a little against the
     air, so it trails while moving. It leans on a second, slower spring, swings to rest after the drop and
     stays inside PAD. Fixed substeps keep the motion the same at any frame rate. */
  const K = 190, C_REL = 9.8, C_AIR = 4, K_LEAN = 140, C_LEAN = 10, LEAN = 0.1, ROOM = PAD - 8, STEP = 1 / 240;
  const trail = { on: false, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, avx: 0, avy: 0, seen: 0, th: 0, vth: 0, t: 0 };
  const soft = (r) => ROOM * Math.tanh(r / ROOM);
  on("drag-move", ([x, y, vx, vy]) => {
    const now = performance.now();
    Object.assign(trail, { ax: x / scale, ay: y / scale, avx: vx / scale, avy: vy / scale, seen: now });
    if (pet && pet.tilt && !tilt.on && !calm.matches) { Object.assign(tilt, { on: true, t: now }); requestAnimationFrame(tiltFrame); }
    if (trail.on || calm.matches) return;
    Object.assign(trail, { on: true, x: trail.ax, y: trail.ay, vx: trail.avx, vy: trail.avy, th: 0, vth: 0, t: now });
    requestAnimationFrame(trailFrame);
  });
  function trailFrame(now) {
    const T = trail, dt = Math.min(0.05, Math.max(0, (now - T.t) / 1000)), n = Math.max(1, Math.ceil(dt / STEP)), h = dt / n;
    let ax = T.ax, ay = T.ay;
    for (let i = 1; i <= n; i++) {
      // the window keeps moving between reports, so carry it on by its velocity (briefly, in case they stop)
      const age = Math.min(0.02, Math.max(0, (T.t - T.seen) / 1000 + i * h));
      ax = T.ax + T.avx * age; ay = T.ay + T.avy * age;
      T.vx += (K * (ax - T.x) - C_REL * (T.vx - T.avx) - C_AIR * T.vx) * h; T.x += T.vx * h;
      T.vy += (K * (ay - T.y) - C_REL * (T.vy - T.avy) - C_AIR * T.vy) * h; T.y += T.vy * h;
      T.vth += (K_LEAN * ((T.x - ax) * LEAN - T.th) - C_LEAN * T.vth) * h; T.th += T.vth * h;
    }
    T.t = now;
    const rx = T.x - ax, ry = T.y - ay;
    const rest = !drag && Math.abs(T.avx) + Math.abs(T.avy) < 1 && Math.hypot(rx, ry) < 0.15 &&
      Math.hypot(T.vx - T.avx, T.vy - T.avy) < 2 && Math.abs(T.th) < 0.02 && Math.abs(T.vth) < 0.3;
    if (rest) { T.on = false; elStack.style.transform = ""; requestAnimationFrame(sendRects); return; }
    // trailing to the left tips the far end of the stack left: anticlockwise above the pet, clockwise below
    const lean = place.v === "above" ? T.th : -T.th;
    elStack.style.transform = `translate(${soft(rx).toFixed(2)}px, ${soft(ry).toFixed(2)}px) rotate(${lean.toFixed(3)}deg)`;
    requestAnimationFrame(trailFrame);
  }

  /* Pets whose run rows aren't a proper walk cycle can lean into the drag instead (pet.json
     claudeCompanion.tilt, a toggle in the editor): the sprite tips from its feet toward where the window is
     heading, up to sprite.TILT degrees for a fast drag, on a loose spring that sways it upright after the drop.
     It's the `rotate` property, so the pose pop's transform still plays on top. */
  const TILT_V = 1100, K_TILT = 160, C_TILT = 11;
  const tilt = { on: false, a: 0, v: 0, t: 0 };
  function tiltFrame(now) {
    const T = tilt, dt = Math.min(0.05, Math.max(0, (now - T.t) / 1000)), n = Math.max(1, Math.ceil(dt / STEP)), h = dt / n;
    const want = pet && pet.tilt ? sprite.TILT * Math.tanh(trail.avx / TILT_V) : 0;
    for (let i = 0; i < n; i++) { T.v += (K_TILT * (want - T.a) - C_TILT * T.v) * h; T.a += T.v * h; }
    T.t = now;
    if (!drag && Math.abs(want) < 0.05 && Math.abs(T.a) < 0.05 && Math.abs(T.v) < 0.5) {
      Object.assign(T, { on: false, a: 0, v: 0 }); elSprite.style.rotate = ""; return;
    }
    elSprite.style.rotate = T.a.toFixed(2) + "deg";
    requestAnimationFrame(tiltFrame);
  }

  on("cursor", ([x, y]) => {
    const hp = inPet(x, y);
    if (hp !== hoverPet) { hoverPet = hp; elPet.classList.toggle("hover", hp); updateSprite(); requestAnimationFrame(sendRects); }
    for (const p of elStack.querySelectorAll(".pill")) {
      const r = p.getBoundingClientRect();
      p.classList.toggle("hover", x >= r.left && x < r.right && y >= r.top && y < r.bottom);
    }
    hoverFan(x, y);
    // v2 pets turn toward a nearby cursor while idle, running or waving (Codex's look frames)
    if (!pet || pet.version !== 2 || !S || !S.look || drag || transient || hp) { player.setLook(null); return; }
    const st = player.state;
    const r = elPet.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    const near = d < dims.S * 2.4 && (st === "idle" || st === "running" || st === "waving");
    player.setLook(near ? sprite.lookFrame(r, { x, y }, 2) : null);
  });

  elPet.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".tools, .badge")) return;
    e.preventDefault();
    elPet.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x0: e.screenX, y0: e.screenY, lx: e.screenX, moved: false };
  });
  elPet.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.screenX - drag.x0, e.screenY - drag.y0) >= 4) {
      drag.moved = true; elPet.classList.add("dragging"); player.setLook(null);
      invoke("drag_start").catch(() => {});
    }
    if (!drag.moved) return;
    const d = e.screenX - drag.lx;
    if (d >= 4 || d <= -4) { drag.lx = e.screenX; transient = d > 0 ? "running-right" : "running-left"; updateSprite(); }
  });
  async function endDrag(e) {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    elPet.classList.remove("dragging");
    if (!d.moved) { if (e.type === "pointerup") { expanded = !expanded; folded = false; render(); } return; }
    try {
      const [x, y] = await invoke("drag_stop");
      const off = petOffset();
      S.petX = x + off.x * scale; S.petY = y + off.y * scale;
      await placeWindow(true);
    } catch (err) { /* window gone */ }
    transient = null;
    updateSprite();
  }
  /* Ctrl- or ⌘-scroll over the pet resizes it (a touchpad pinch arrives as one), about 8% a notch. It goes through
     the settings like the slider does, so applySettings sizes and places it and Settings follows. */
  let wheelScale = null, wheelSent = null, wheelIdle = 0;
  elPet.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!S || drag) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
    if (wheelScale == null) wheelScale = wheelSent = scaleOf(S);
    wheelScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, wheelScale * Math.exp(-dy * 0.0008)));
    clearTimeout(wheelIdle);
    wheelIdle = setTimeout(() => { wheelScale = wheelSent = null; }, 400);
    const v = Math.round(wheelScale * 100) / 100;
    if (v === wheelSent) return;
    wheelSent = v;
    invoke("set_settings", { patch: { petScale: v } }).catch(() => {});
  }, { passive: false });

  elPet.addEventListener("pointerup", endDrag);
  elPet.addEventListener("pointercancel", endDrag);
  elPet.addEventListener("lostpointercapture", endDrag);
  document.addEventListener("contextmenu", (e) => { e.preventDefault(); if (e.target.closest("#pet")) invoke("pet_menu").catch(() => {}); });

  elTools.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.act === "claude") invoke("open_claude_app");
    if (b.dataset.act === "edit") invoke("edit_active_pet");
    if (b.dataset.act === "app") invoke("show_main_view", { view: null });
    if (b.dataset.act === "fold") { folded = !folded; expanded = false; fan = false; render(); }
  });
  elTools.addEventListener("pointerdown", (e) => e.stopPropagation());
  // the keys take clicks where they land, not where they start springing out from
  elTools.addEventListener("transitionend", (e) => { if (e.target === elTools && e.propertyName === "transform") sendRects(); });
  elBadge.addEventListener("pointerdown", (e) => e.stopPropagation());
  elBadge.addEventListener("click", (e) => {
    e.stopPropagation();
    if ((S && S.pill) === "never") invoke("show_main_view", { view: "claude" });
    else { folded = false; render(); }
  });

  elStack.addEventListener("click", (e) => {
    const x = e.target.closest("[data-x]");
    if (x) { invoke("dismiss", { id: x.dataset.x }); return; }
    const xc = e.target.closest("[data-xcd]");
    if (xc) { invoke("dismiss_countdown", { key: xc.dataset.xcd }); return; }
    if (e.target.closest("[data-open]")) { expanded = true; render(); return; }
    if (e.target.closest("[data-app]")) { invoke("show_main_view", { view: "claude" }); return; }
    const p = e.target.closest(".pill");
    if (!p || p.dataset.id === "_idle") return;
    if (p.dataset.cd) { invoke("open_collegiapp", { id: p.dataset.cd }).catch(() => {}); return; }
    invoke("open_chat", { id: p.dataset.id });
    const s = sessions.find((s) => s.id === p.dataset.id);
    if (s && (s.status === "review" || s.status === "failed")) invoke("dismiss", { id: s.id });
  });

  /* ───────── boot ───────── */
  (async function boot() {
    if (!CC.live) return;
    player.play("waving", { force: true });
    await applySettings(await invoke("get_settings"));
    setSessions(await invoke("get_sessions").catch(() => []));
    setCountdowns(await invoke("get_countdowns").catch(() => []), true);
    on("settings", applySettings);
    on("sessions", setSessions);
    on("countdowns", (list) => setCountdowns(list));
    on("pets", (id) => { if (!pet || id === pet.id) loadPet(); });
    new ResizeObserver(() => requestAnimationFrame(sendRects)).observe(elStack);
  })();
})();
