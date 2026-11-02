/* The pet overlay window. Rust (overlay.rs) keeps it on top and click-through outside the rects this file
   reports, follows the cursor while dragging and streams the cursor position; this file owns the layout.
   Layout: the window is bigger than the pet, which sits in its middle with room for the pills on every side.
   Where the pet sits on its monitor picks the placement, like Codex's top-/bottom-start/end: in the upper part
   of the screen the pills hang below it, otherwise they stack above; on the right half they align to the pet's
   right edge and grow left, on the left half the reverse. Dragging changes it as the pet crosses those lines,
   and overlay.rs stops the pet at the screen's edges as it goes. The pet's screen spot (settings petX/petY,
   physical px) is fixed; the window moves around it.
   Several chats make a deck: the front pill is a chat that needs you, else the one closest to completion
   (sessions.rs orders the list),
   with up to two more peeking out behind it on the side away from the pet; finished chats sit at the back,
   tinted and labelled Done. Collegiapp countdowns (collegiapp.rs: a class from an hour out, work from a day out) always queue
   behind the chats, so they're in front only while Claude has nothing to show; their clocks tick here every second.
   While the pills are hidden, a bell with the number of chats brings them back. Hovering the deck fans it out into
   every chat that fits; clicking the pet pins that open. Every pill moves on its own springs (see motion): out of
   the deck and back, to a new place, in and out, and trailing the pet on a chain while it's dragged. Sprite state
   follows the most urgent session (waiting > failed > review > running > idle); hover jumps, dragging runs
   left/right (pets set to tilt lean into it), v2 pets look toward a nearby cursor, the app says hello
   with a wave. The pills wear the theme in use, the night theme too (themes.js pills()). Its size is a share of
   Codex's (petScale: Settings' slider, the Size menu, Ctrl-scroll or a pinch over the pet). */
(function () {
  const { $, esc, ic, invoke, on, sprite } = CC, TH = CC.themes;
  // Codex draws the pet 7.04rem wide; petScale sizes it from half that to twice
  const CODEX_W = 112.64, MIN_SCALE = 0.5, MAX_SCALE = 2;
  const scaleOf = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s && s.petScale) || 1));
  // PAD is the clear room round the window's parts the pills can swing into while dragged; KEYS is the band
  // the hover keys pop out into, under the pet (over its head when the pills hang below). The window has room
  // for the pills and the keys on both sides of the pet, so they change sides mid-drag without it moving.
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

  const elPet = $("#pet"), elSprite = $("#sprite"), elStack = $("#stack"), elGhosts = $("#ghosts"), elBadge = $("#badge"), elTools = $("#tools");
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
  let dims = { S: CODEX_W, SH: CODEX_W * 208 / 192, side: 0, room: 0, W: 0, H: 0 };
  let place = { v: "above", h: "end" }, placed = false, scale = 1, monitors = [];
  let expanded = false, folded = false, fan = false, fanTimer = null, hoverPet = false, transient = null, drag = null;
  // what the stack shows (none · deck · list); the deck keeps up to DECK pills, the ones past its layers hidden
  let shape = "none";
  const DECK = 9;
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
    const s = CODEX_W * scaleOf(S), sh = (s * 208) / 192, side = Math.max(0, PILL_W - s), room = Math.max(GAP + STACK_H, KEYS);
    dims = { S: s, SH: sh, side, room, W: Math.ceil(s + 2 * side + 2 * PAD), H: Math.ceil(sh + 2 * room + 2 * PAD) };
    document.documentElement.style.setProperty("--pw", s + "px");
  }
  const petOffset = () => ({ x: PAD + dims.side, y: PAD + dims.room });
  // the monitor under a point, else the nearest one (overlay.rs on_screen picks the same)
  function monitorNear(mons, x, y) {
    const gap = (m) => Math.hypot(Math.max(m[0] - x, x - m[0] - m[2], 0), Math.max(m[1] - y, y - m[1] - m[3], 0));
    return mons.reduce((a, m) => (!a || gap(m) < gap(a) ? m : a), null);
  }
  /* The pills' side for a pet centred on (cx, cy). `was`, the side they're on, holds until the pet is 4% of the
     screen past the line, so a drag along it doesn't flip them back and forth. */
  function placeOn(mon, cx, cy, was) {
    const m = was ? 0.04 : 0, v = 0.45 + (was && was.v === "below" ? m : -m), h = 0.5 + (was && was.h === "end" ? -m : m);
    return { v: (cy - mon[1]) / mon[3] < v ? "below" : "above", h: (cx - mon[0]) / mon[2] > h ? "end" : "start" };
  }

  async function placeWindow(save) {
    let info;
    try { info = await invoke("overlay_info"); } catch (e) { return; }
    scale = info.scale || 1;
    monitors = info.monitors;
    const pw = dims.S * scale, ph = dims.SH * scale;
    let px = S.petX, py = S.petY;
    if (px == null || py == null) {
      const m = monitorNear(info.monitors, info.x + 10, info.y + 10) || [0, 0, 1280, 720];
      px = m[0] + m[2] - pw - 28 * scale; py = m[1] + m[3] - ph - KEYS * scale;
    }
    const mon = monitorNear(info.monitors, px + pw / 2, py + ph / 2) || [0, 0, 1280, 720];
    // the pet keeps the keys' band on screen above and below it (overlay.rs keeps it there while it's dragged)
    px = Math.min(Math.max(px, mon[0]), mon[0] + mon[2] - pw);
    py = Math.min(Math.max(py, mon[1] + KEYS * scale), mon[1] + mon[3] - ph - KEYS * scale);
    place = placeOn(mon, px + pw / 2, py + ph / 2, placed && place);
    placed = true;
    const off = petOffset(), wx = Math.round(px - off.x * scale), wy = Math.round(py - off.y * scale);
    await invoke("overlay_set", { x: wx, y: wy, width: dims.W, height: dims.H }).catch(() => {});
    shiftBodies((info.x - wx) / scale, (info.y - wy) / scale);
    layout();
    if (save) { S.petX = px; S.petY = py; invoke("set_settings", { patch: { petX: px, petY: py } }).catch(() => {}); }
    // a move onto a monitor with another scale resizes the window; place once more with the new scale
    const after = await invoke("overlay_info").catch(() => null);
    if (after && Math.abs((after.scale || 1) - scale) > 0.01) { scale = after.scale; return placeWindow(save); }
  }

  function layout() {
    const off = petOffset(), sw = Math.max(PILL_W, dims.S), above = place.v === "above";
    Object.assign(elPet.style, { left: off.x + "px", top: off.y + "px" });
    elStack.className = `stack ${place.v} ${place.h}`;
    elPet.classList.toggle("keys-up", !above);
    Object.assign(elStack.style, {
      width: sw + "px", maxHeight: STACK_H + "px", left: (place.h === "end" ? off.x + dims.S - sw : off.x) + "px",
      top: above ? "" : off.y + dims.SH + GAP + "px", bottom: above ? dims.H - off.y + GAP + "px" : "",
    });
    if (shape === "deck") stackLayers();
    settle("");
    requestAnimationFrame(sendRects);
  }

  /* While the pet is dragged (and while it glides to rest) the pills change sides as soon as it crosses a line. */
  function follow(x, y) {
    const off = petOffset(), pw = dims.S * scale, ph = dims.SH * scale;
    const cx = x + off.x * scale + pw / 2, cy = y + off.y * scale + ph / 2, mon = monitorNear(monitors, cx, cy);
    if (!mon) return;
    const next = placeOn(mon, cx, cy, place);
    if (next.v !== place.v || next.h !== place.h) { place = next; layout(); }
  }

  /* A part's box as laid out, before its springs move it: stage px, which are the window's CSS px. */
  function box(el) {
    let x = 0, y = 0;
    for (let e = el; e && e.id !== "stage"; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  /* only the pet, its keys (while they're out) and the pills take clicks; everything else falls through to the
     desktop. The keys stay laid out to animate, so they count only while the pet is hovered. The pills count
     where they're laid out, so they take the cursor where they're headed while they spring there. */
  const keysOut = () => hoverPet && !drag;
  const targets = () => elStack.querySelectorAll(".pill:not(.lyh), .more");
  function sendRects() {
    const parts = [elPet, elBadge].concat(keysOut() ? [elTools] : []).filter((e) => e.offsetParent !== null || e === elPet);
    const rects = parts.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })
      .concat([...targets()].map((e) => { const r = box(e); return [r.x, r.y, r.w, r.h]; }))
      .map((r) => r.map(Math.round));
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
  /* A pill's opening tag. `k` keys its springs (motion), so a pill keeps moving through redraws. The deck's layers
     are pills too, their faces hidden (pet.css .ly): `ly` 1 and 2 peek out behind the front one, 3 on wait hidden. */
  function tag(cls, k, attrs, tip, ly) {
    const role = !ly ? "" : ly < 3 ? ` ly ly${ly}` : " ly lyh";
    return `<div class="pill ${cls}${role}" data-k="${esc(k)}" ${attrs}` +
      (ly ? ` data-ly="${ly}" data-open title="Show them all">` : ` title="${esc(tip)}">`);
  }

  function pillHtml(s, exp, behind, ly) {
    const st = STAT[s.status] || STAT.idle;
    const pct = s.status !== "review" && s.status !== "idle" && s.progress != null ? s.progress : null;
    let sub = s.subtitle || (s.status === "running" ? "Thinking" : "");
    if (!exp && s.step && (sub === "Thinking" || !sub)) sub = s.step;
    // chats the desktop app started open there (open_chat); terminal chats just open the app
    const act = s.id === "_idle" ? "" : s.hostSession ? "Click to open this chat in Claude" : "Click to open Claude";
    const tip = [s.title, s.step, s.subtitle, s.cwd, act].filter(Boolean).join("\n");
    return tag(`s-${s.status}${exp ? " exp" : ""}`, "s:" + s.id, `data-id="${esc(s.id)}"`, tip, ly) +
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

  function cdHtml(c, exp, behind, ly) {
    const now = Date.now(), ph = cdPhase(c, now);
    const [icon, name] = KINDS[c.kind] || ["work", "Due"];
    const label = ph === "live" ? (c.kind === "class" ? "In class" : "On now") : ph === "now" ? "Now" : name;
    const when = ph === "live" ? "Until " + hm(c.end) : c.group === "class" ? hm(c.at) : dayOf(c.at) + " " + hm(c.at);
    // the course code unless the title already says it ("CMPSC 130A Lecture")
    const course = c.course && !squash(c.title).includes(squash(c.course)) ? c.course : "";
    const sub = [course, c.location, when].filter(Boolean).join(" · ");
    const tip = [c.title, sub, "Click to open Collegiapp"].join("\n");
    const kc = c.color >= 1 && c.color <= 6 ? ` style="--kc:var(--k${c.color})"` : "";
    return tag(`cd p-${ph}${exp ? " exp" : ""}`, "c:" + c.key, `data-cd="${esc(c.id)}"${kc}`, tip, ly) +
      `<span class="st">${ic(icon)}</span>` +
      `<span class="tx"><span class="t1"><b class="ti">${esc(c.title)}</b><span class="lb">${label}</span>${behindHtml(behind)}</span>` +
      `<span class="t2">${esc(sub)}</span></span>` +
      `<span class="pc">${cdClock(c, now)}</span><i class="bar"><i style="width:${(cdFrac(c, now) * 100).toFixed(2)}%"></i></i>` +
      `<button class="x" data-xcd="${esc(c.key)}" title="Hide this countdown" aria-label="Hide this countdown">${ic("close")}</button></div>`;
  }

  const anyHtml = (x, exp, behind, ly) => (countdowns.includes(x) ? cdHtml(x, exp, behind, ly) : pillHtml(x, exp, behind, ly));

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
    const next = !show ? "none" : open ? "list" : "deck";
    const kind = shape === "deck" && next === "list" ? "open" : shape === "list" && next === "deck" ? "close" : "";
    shape = next;
    if (!show) elStack.innerHTML = "";
    else if (open) {
      elStack.innerHTML = list.map((s) => anyHtml(s, expanded)).join("");
      fit(list.length);
    } else {
      // the next ones wait behind the front pill as its layers, so opening the deck brings each one out from there
      elStack.innerHTML = anyHtml(list[0], expanded, list.length - 1) + list.slice(1, DECK).map((s, i) => anyHtml(s, false, 0, i + 1)).join("");
      stackLayers();
    }
    settle(kind);
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
      elStack.insertAdjacentHTML("beforeend", `<button class="more" data-app data-k="more" title="Open the Claude view">+${total - n} more</button>`);
      while (n > 1 && over()) { pills[--n].remove(); elStack.querySelector(".more").textContent = `+${total - n} more`; }
    }
  }

  /* The deck's layers peek out behind the front pill on the side away from the pet, 7 and 13 px, each 10 px
     narrower a side than the one before; the rest wait hidden behind the second. */
  function stackLayers() {
    const front = elStack.firstElementChild;
    if (!front) return;
    const away = place.v === "above" ? -1 : 1;
    for (const el of elStack.querySelectorAll(".ly")) {
      const n = Math.min(2, +el.dataset.ly);
      Object.assign(el.style, {
        left: front.offsetLeft + 10 * n + "px", top: front.offsetTop + away * (n === 1 ? 7 : 13) + "px",
        width: front.offsetWidth - 20 * n + "px", height: front.offsetHeight + "px",
      });
    }
  }

  /* Hovering the deck fans it out after a beat; leaving the pills (gaps included) folds it back. The pills count
     where they're headed, so one still springing out doesn't fold the deck again. */
  function overPills(x, y, pad) {
    for (const el of targets()) {
      const r = box(el);
      if (x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad) return true;
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

  /* ───────── motion ───────── */
  /* Every part of the stack (each pill, the deck's layers, the "+n more" key) is a body with its own springs, keyed
     by its chat or countdown (data-k) so it keeps moving through redraws. A redraw measures where each part is
     laid out now (its slot) and carries the body over from where it was drawn, FLIP-style: the corner by the pet
     takes the offset, the plate (pet.css ::before) the size, so the face never stretches. From there:
     - Opening the deck, each pill comes out from behind the front one, the nearest first, its plate growing out
       of its layer and its face fading in; closing tucks them back in from the far end. A face shows only once its
       plate about fits it, so a pill that grows (a longer title, a click to expand) never spills past its plate.
     - A new part pops out from the pet; a part that's gone fades and shrinks toward the pet where it was, under
       the stack (#ghosts). Changing sides mid-drag sends every pill round to its new spot.
     - While the pet is dragged the pills trail it on a chain. Rust reports the window's eased position and
       velocity ("drag-move", physical px); the front pill is a mass pulled after the window, damped mostly
       against the window's own motion, so every speed-up, slow-down and turn moves it, and a little against the
       air, so it trails while moving; each pill after it hangs the same way on the one before, so the far end
       lags, swings and settles a beat after the near one. Each leans on a slower spring about the stack's corner
       by the pet, toward its trail capped inside PAD (so about 2° at most, however fast the drag), and SWAY
       scales what all that shows.
     The springs run in fixed substeps, so the motion is the same at any frame rate, and stop once everything is
     still, leaving no inline styles behind. Reduced motion skips all of it. */
  const K = 190, C_REL = 9.8, C_AIR = 4, K_LEAN = 140, C_LEAN = 10, LEAN = 0.1, ROOM = PAD - 8, STEP = 1 / 240;
  // each link of the chain: stiff and well damped, so the far end swings a little more than the near one, not wildly
  const K_LINK = 900, C_LINK = 54, C_LINK_AIR = 1;
  // how much of the drag's trail and lean shows: 70% of the spring's, so a fast drag stays calm
  const SWAY = 0.7;
  // moving between slots: a quick settle with a touch of overshoot; the pop's scale is a little bouncier
  const W_L = 21, K_L = W_L * W_L, C_L = 2 * 0.68 * W_L, K_S = 400, C_S = 22;
  // opening fans the pills out from the nearest, 26 ms apart; closing tucks them in from the far end, 18 ms apart
  const FAN_OUT = 0.026, FAN_IN = 0.018, POP_GAP = 0.04;
  // what each role settles to: opacity, the face's opacity (--c) and how deep in the deck it is (--m)
  const REST = { pill: [1, 1, 0], more: [1, 1, 0], ly1: [1, 0, 1], ly2: [1, 0, 2], lyh: [0, 0, 2] };
  const VARS = ["--c", "--m", "--px", "--py"];
  const trail = { on: false, avx: 0, avy: 0, seen: -1e9 };
  const soft = (r) => ROOM * Math.tanh(r / ROOM);
  const ease = (v, to, rate, h) => to + (v - to) * Math.exp(-rate * h);
  let bodies = new Map(), ghosts = [], running = false, last = 0;

  const roleOf = (el) => (el.classList.contains("more") ? "more" : el.classList.contains("lyh") ? "lyh" :
    el.classList.contains("ly1") ? "ly1" : el.classList.contains("ly2") ? "ly2" : "pill");
  const born = () => ({
    lx: 0, ly: 0, lvx: 0, lvy: 0, px: 1, py: 1, pvx: 0, pvy: 0, s: 1, vs: 0, a: 1, c: 1, m: 0, wait: 0,
    dx: 0, dy: 0, dvx: trail.on ? trail.avx : 0, dvy: trail.on ? trail.avy : 0, th: 0, vth: 0, slot: null, drawn: false,
  });
  // the window's velocity as last reported (until the reports stop coming), and whether a drag is in play
  function windowAt(t) {
    const on = t - trail.seen < 60, wx = on ? trail.avx : 0, wy = on ? trail.avy : 0;
    return { wx, wy, moving: !!(drag && drag.moved) || Math.abs(wx) + Math.abs(wy) >= 1 };
  }
  // the box a body is drawn in, leaving out the drag: its plate's size, placed by the corner by the pet
  function drawnBox(b) {
    const { x, y, w, h } = b.slot, W = w * b.px, H = h * b.py;
    const cx = (b.end ? x + w : x) + b.lx, cy = (b.above ? y + h : y) + b.ly;
    return { x: b.end ? cx - W : cx, y: b.above ? cy - H : cy, w: W, h: H };
  }

  /* After a redraw (or a new place): matches the stack's parts to their bodies and carries each over. `kind` is
     "open" or "close" when the deck just fanned out or folded up. */
  function settle(kind) {
    const els = [...elStack.children], end = place.h === "end", above = place.v === "above";
    els.forEach((el, i) => { el.style.zIndex = 40 - i; });
    if (calm.matches) {
      for (const g of ghosts) g.el.remove();
      ghosts = []; bodies = new Map();
      return;
    }
    const st = box(elStack), pv = { x: st.x + (end ? st.w : 0), y: st.y + (above ? st.h : 0) };
    const live = new Map(), fresh = [], turned = [];
    els.forEach((el, rank) => {
      const k = el.dataset.k, slot = box(el), role = roleOf(el);
      let b = bodies.get(k);
      if (!b) { b = born(); fresh.push(b); }
      else if (b.slot && slot.w && slot.h) {
        const was = drawnBox(b);
        b.pvx *= b.slot.w / slot.w; b.pvy *= b.slot.h / slot.h;
        b.px = was.w / slot.w; b.py = was.h / slot.h;
        b.lx = (end ? was.x + was.w : was.x) - (end ? slot.x + slot.w : slot.x);
        b.ly = (above ? was.y + was.h : was.y) - (above ? slot.y + slot.h : slot.y);
        // the lean's sign goes with the side, so a flip keeps the pill turned as it was
        if (b.above !== above) { b.th = -b.th; b.vth = -b.vth; }
        const out = role === "pill" || role === "more", wasOut = b.role === "pill" || b.role === "more";
        // a layer lays its face out narrower, so a pill turning into one drops most of its face at once
        if (wasOut && !out) b.c = Math.min(b.c, 0.5);
        if (kind && out !== wasOut) turned.push(b);
      }
      const [ta, tc, tm] = REST[role];
      Object.assign(b, { k, el, role, rank, slot, end, above, pv, ta, tc, tm, ts: 1 });
      live.set(k, b);
    });
    // out of the deck from the nearest, back into it from the farthest
    const far = Math.max(0, ...turned.map((b) => b.rank));
    for (const b of turned) b.wait = kind === "open" ? b.rank * FAN_OUT : (far - b.rank) * FAN_IN;
    const first = Math.min(...fresh.map((b) => b.rank));
    for (const b of fresh) {
      Object.assign(b, { a: b.ta, c: b.tc, m: b.tm });
      if (!b.ta) continue;
      // a new part pops out from behind the pet
      Object.assign(b, { a: 0, s: 0.6, ly: above ? 14 : -14, wait: kind === "open" ? b.rank * FAN_OUT : (b.rank - first) * POP_GAP });
    }
    for (const [k, b] of bodies) if (!live.has(k)) leave(b);
    bodies = live;
    const { wx, wy, moving } = windowAt(performance.now());
    let busy = false;
    for (const b of bodies.values()) busy = draw(b, wx, wy, moving) || busy;
    if (busy) kick();
  }

  /* The window moved under the stack (a new size, or the pet sent to its corner). A short way, the pills keep
     their spot on screen and spring to their new ones; a long way, they pop in afresh. */
  function shiftBodies(dx, dy) {
    if (!dx && !dy) return;
    for (const g of ghosts) g.el.remove();
    ghosts = [];
    if (Math.hypot(dx, dy) > 80) { bodies = new Map(); return; }
    for (const b of bodies.values()) if (b.slot) b.slot = { ...b.slot, x: b.slot.x + dx, y: b.slot.y + dy };
  }

  /* A part that's gone: its element stays where it was drawn, in the layer under the stack, fading out. */
  function leave(b) {
    if (calm.matches || b.a < 0.05 || !b.slot) return;
    const el = b.el, r = b.slot;
    el.classList.add("gone");
    el.classList.remove("hover");
    delete el.dataset.k;
    Object.assign(el.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    el.style.setProperty("--ox", b.end ? "right" : "left");
    el.style.setProperty("--oy", b.above ? "bottom" : "top");
    elGhosts.append(el);
    Object.assign(b, { role: "gone", ta: 0, tc: b.c, tm: b.m, ts: 0.7, wait: 0 });
    ghosts.push(b);
    kick();
  }

  function kick() {
    if (running || calm.matches) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function step(b, prev, wx, wy, h) {
    // a face on its way out doesn't wait its turn
    if (b.c > b.tc) b.c = ease(b.c, b.tc, 28, h);
    if (b.wait > 0) b.wait -= h;
    else {
      b.lvx += (-K_L * b.lx - C_L * b.lvx) * h; b.lx += b.lvx * h;
      b.lvy += (-K_L * b.ly - C_L * b.lvy) * h; b.ly += b.lvy * h;
      b.pvx += (K_L * (1 - b.px) - C_L * b.pvx) * h; b.px += b.pvx * h;
      b.pvy += (K_L * (1 - b.py) - C_L * b.pvy) * h; b.py += b.pvy * h;
      b.vs += (K_S * (b.ts - b.s) - C_S * b.vs) * h; b.s += b.vs * h;
      b.a = ease(b.a, b.ta, b.ta > b.a ? 16 : 13, h);
      if (b.c < b.tc) b.c = ease(b.c, b.tc, 11, h);
      b.m = ease(b.m, b.tm, 12, h);
    }
    // the drag: the front pill hangs on the window, every other on the one before it; velocities are on screen
    if (prev) {
      b.dvx += (K_LINK * (prev.dx - b.dx) - C_LINK * (b.dvx - prev.dvx) - C_LINK_AIR * b.dvx) * h;
      b.dvy += (K_LINK * (prev.dy - b.dy) - C_LINK * (b.dvy - prev.dvy) - C_LINK_AIR * b.dvy) * h;
    } else {
      b.dvx += (-K * b.dx - C_REL * (b.dvx - wx) - C_AIR * b.dvx) * h;
      b.dvy += (-K * b.dy - C_REL * (b.dvy - wy) - C_AIR * b.dvy) * h;
    }
    b.dx += (b.dvx - wx) * h; b.dy += (b.dvy - wy) * h;
    // the lean follows the trail as it shows, capped like it, so a fast drag doesn't tip the pills over
    b.vth += (K_LEAN * (soft(b.dx) * LEAN - b.th) - C_LEAN * b.vth) * h; b.th += b.vth * h;
  }

  /* Puts a body on screen; once it's still, snaps it to rest, clears its inline styles and says so. */
  function draw(b, wx, wy, moving) {
    const el = b.el;
    const still = !moving && b.wait <= 0 && Math.abs(b.lx) + Math.abs(b.ly) < 0.4 && Math.abs(b.lvx) + Math.abs(b.lvy) < 4 &&
      Math.abs(b.px - 1) + Math.abs(b.py - 1) < 0.003 && Math.abs(b.pvx) + Math.abs(b.pvy) < 0.04 &&
      Math.abs(b.s - b.ts) < 0.003 && Math.abs(b.vs) < 0.04 && Math.abs(b.a - b.ta) < 0.01 && Math.abs(b.c - b.tc) < 0.01 &&
      Math.abs(b.m - b.tm) < 0.01 && Math.abs(b.dx) + Math.abs(b.dy) < 0.2 && Math.abs(b.dvx - wx) + Math.abs(b.dvy - wy) < 2 &&
      Math.abs(b.th) < 0.02 && Math.abs(b.vth) < 0.3;
    if (still) {
      Object.assign(b, { lx: 0, ly: 0, lvx: 0, lvy: 0, px: 1, py: 1, pvx: 0, pvy: 0, s: b.ts, vs: 0, a: b.ta, c: b.tc, m: b.tm });
      Object.assign(b, { dx: 0, dy: 0, dvx: wx, dvy: wy, th: 0, vth: 0 });
      if (b.drawn) {
        b.drawn = false;
        el.style.transform = el.style.opacity = "";
        for (const p of VARS) el.style.removeProperty(p);
      }
      return false;
    }
    // trailing to the left tips the far end of the stack left: anticlockwise above the pet, clockwise below. It
    // turns about the stack's corner by the pet (vx, vy); the pop's scale is about the part's own (ox, oy).
    const tx = b.lx + SWAY * soft(b.dx), ty = b.ly + SWAY * soft(b.dy), th = SWAY * (b.above ? b.th : -b.th);
    const { x, y, w, h } = b.slot, ox = b.end ? w : 0, oy = b.above ? h : 0, vx = b.pv.x - x, vy = b.pv.y - y;
    const f = (v) => v.toFixed(2);
    el.style.transform = `translate(${f(tx + vx)}px, ${f(ty + vy)}px) rotate(${th.toFixed(3)}deg) ` +
      `translate(${f(ox - vx)}px, ${f(oy - vy)}px) scale(${b.s.toFixed(4)}) translate(${f(-ox)}px, ${f(-oy)}px)`;
    // the face shows once its plate has about grown to fit it (within 4 px), so it never spills past the edge
    const short = Math.max(0, (1 - b.px) * w, (1 - b.py) * h), face = b.c * Math.min(1, Math.max(0, 1 - (short - 4) / 12));
    el.style.opacity = b.a.toFixed(3);
    el.style.setProperty("--c", face.toFixed(3));
    el.style.setProperty("--m", b.m.toFixed(3));
    el.style.setProperty("--px", b.px.toFixed(4));
    el.style.setProperty("--py", b.py.toFixed(4));
    b.drawn = true;
    return true;
  }

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)), n = Math.max(1, Math.ceil(dt / STEP)), h = dt / n;
    last = now;
    const chain = [...bodies.values()].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i <= n; i++) {
      const { wx, wy } = windowAt(now - (n - i) * h * 1000);
      let prev = null;
      for (const b of chain) { step(b, prev, wx, wy, h); prev = b; }
      for (const g of ghosts) step(g, null, wx, wy, h);
    }
    const { wx, wy, moving } = windowAt(now);
    let busy = moving;
    for (const b of chain) busy = draw(b, wx, wy, moving) || busy;
    ghosts = ghosts.filter((g) => {
      if (draw(g, wx, wy, moving) && g.a > 0.01) return true;
      g.el.remove();
      return false;
    });
    if (busy || ghosts.length) { requestAnimationFrame(frame); return; }
    running = false;
    trail.on = false;
    requestAnimationFrame(sendRects);
  }

  on("drag-move", ([x, y, vx, vy]) => {
    const now = performance.now();
    Object.assign(trail, { avx: vx / scale, avy: vy / scale, seen: now });
    follow(x, y);
    if (pet && pet.tilt && !tilt.on && !calm.matches) { Object.assign(tilt, { on: true, t: now }); requestAnimationFrame(tiltFrame); }
    if (calm.matches) return;
    // a drag starts with every pill moving along with the window, so nothing jolts
    if (!trail.on) {
      trail.on = true;
      for (const b of [...bodies.values(), ...ghosts]) { b.dvx = trail.avx; b.dvy = trail.avy; }
    }
    kick();
  });

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
    for (const p of elStack.querySelectorAll(".pill:not(.ly)")) {
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
      const off = petOffset();
      invoke("drag_start", { pet: [off.x, off.y, dims.S, dims.SH, KEYS] }).catch(() => {});
      // follow() places the pills from these as the pet crosses the screen
      invoke("overlay_info").then((i) => { monitors = i.monitors; }).catch(() => {});
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
