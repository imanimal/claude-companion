/* The pet overlay window. Rust (overlay.rs) keeps it on top and click-through outside the rects this file
   reports, follows the cursor while dragging and streams the cursor position; this file owns the layout.
   Layout: the window is bigger than the pet. Where the pet sits on its monitor picks the placement, like
   Codex's top-/bottom-start/end: in the upper part of the screen the pills hang below it, otherwise they
   stack above; on the right half they align to the pet's right edge and grow left, on the left half the
   reverse. The pet's screen spot (settings petX/petY, physical px) is fixed; the window moves around it.
   Several chats make a deck: the front pill is a chat that needs you, else the one closest to completion
   (sessions.rs orders the list),
   with up to two more peeking out behind it on the side away from the pet; finished chats sit at the back,
   tinted and labelled Done. While the pills are hidden, a bell with the number of chats brings them back. Hovering the deck fans it out into
   every chat that fits; clicking the pet pins that open. Sprite state follows the most urgent session
   (waiting > failed > review > running > idle); hover jumps, dragging runs left/right, v2 pets look toward a
   nearby cursor, the app says hello with a wave. */
(function () {
  const { $, esc, ic, invoke, on, sprite } = CC;
  const SIZES = { s: 88, m: 112.64, l: 144, xl: 176 };
  const PAD = 14, GAP = 6, PILL_W = 300, STACK_H = 360;
  const PRIO = { waiting: 0, failed: 1, review: 2, running: 3, idle: 4 };
  const STAT = {
    running: { icon: "spin", label: "", sprite: "running" },
    waiting: { icon: "warn", label: "Needs input", sprite: "waiting" },
    failed: { icon: "warn", label: "Blocked", sprite: "failed" },
    review: { icon: "okc", label: "Done", sprite: "review" },
    idle: { icon: "clock", label: "", sprite: "idle" },
  };

  const elPet = $("#pet"), elSprite = $("#sprite"), elStack = $("#stack"), elBadge = $("#badge"), elTools = $("#tools");
  const player = new sprite.Player(elSprite);
  let S = null, pet = null, sessions = [];
  let dims = { S: SIZES.m, SH: SIZES.m * 208 / 192, W: 0, H: 0 };
  let place = { v: "above", h: "end" }, scale = 1;
  let expanded = false, folded = false, fan = false, fanTimer = null, hoverPet = false, transient = null, drag = null;
  let awakeUntil = Date.now() + 2300, lastPulse = 0, lastTop = "", sentRects = "";

  elTools.innerHTML = `<button data-act="edit" title="Edit this pet" aria-label="Edit this pet">${ic("edit")}</button>` +
    `<button data-act="claude" title="Open Claude" aria-label="Open Claude">${ic("claude")}</button>` +
    `<button data-act="fold" title="Show or hide updates" aria-label="Show or hide updates">${ic("chev")}</button>` +
    `<span class="sep"></span><button data-act="app" title="Open Claude Companion" aria-label="Open Claude Companion">${ic("paw")}</button>`;

  /* ───────── geometry ───────── */
  function computeDims() {
    const s = SIZES[S && S.petSize] || SIZES.m, sh = (s * 208) / 192;
    dims = { S: s, SH: sh, W: Math.ceil(Math.max(PILL_W, s) + 2 * PAD), H: Math.ceil(sh + GAP + STACK_H + 2 * PAD) };
    document.documentElement.style.setProperty("--pw", s + "px");
  }
  const petOffset = () => ({ x: place.h === "end" ? dims.W - PAD - dims.S : PAD, y: place.v === "above" ? dims.H - PAD - dims.SH : PAD });
  const monitorAt = (mons, x, y) => mons.find((m) => x >= m[0] && y >= m[1] && x < m[0] + m[2] && y < m[1] + m[3]);

  async function placeWindow(save) {
    let info;
    try { info = await invoke("overlay_info"); } catch (e) { return; }
    scale = info.scale || 1;
    const pw = dims.S * scale, ph = dims.SH * scale;
    let px = S.petX, py = S.petY;
    if (px == null || py == null) {
      const m = monitorAt(info.monitors, info.x + 10, info.y + 10) || info.monitors[0] || [0, 0, 1280, 720];
      px = m[0] + m[2] - pw - 28 * scale; py = m[1] + m[3] - ph - 16 * scale;
    }
    const mon = monitorAt(info.monitors, px + pw / 2, py + ph / 2) || info.monitors[0] || [0, 0, 1280, 720];
    px = Math.min(Math.max(px, mon[0]), mon[0] + mon[2] - pw);
    py = Math.min(Math.max(py, mon[1]), mon[1] + mon[3] - ph);
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
    Object.assign(elStack.style, {
      width: dims.W - 2 * PAD + "px", maxHeight: STACK_H + "px", left: PAD + "px",
      top: place.v === "below" ? off.y + dims.SH + GAP + "px" : "", bottom: place.v === "above" ? dims.H - off.y + GAP + "px" : "",
    });
    requestAnimationFrame(sendRects);
  }

  /* only the pet, its keys and the pills take clicks; everything else falls through to the desktop */
  function sendRects() {
    const rects = [elPet, elTools, elBadge, ...elStack.querySelectorAll(".pill, .layer, .more")].filter((e) => e.offsetParent !== null || e === elPet).map((e) => {
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
      (behind ? `<span class="nn" title="${behind} more ${behind === 1 ? "chat" : "chats"}">+${behind}</span>` : "") + `</span>` +
      (exp && s.step ? `<span class="t3">${esc(s.step)}</span>` : "") +
      `<span class="t2">${esc(sub)}</span></span>` +
      (pct != null ? `<span class="pc">${pct}<small>%</small></span><i class="bar"><i style="width:${pct}%"></i></i>` : "") +
      (s.status !== "running" && s.id !== "_idle" ? `<button class="x" data-x="${esc(s.id)}" title="Dismiss" aria-label="Dismiss">${ic("close")}</button>` : "") +
      `</div>`;
  }

  function render() {
    if (!S) return;
    const mode = S.pill || "auto";
    let list = sessions;
    if (!list.length && mode === "always") list = [{ id: "_idle", status: "idle", title: "Claude is idle", subtitle: "Session updates show here" }];
    const show = mode !== "never" && !folded && list.length > 0;
    const open = show && list.length > 1 && (expanded || fan);
    if (!show) elStack.innerHTML = "";
    else if (open) {
      elStack.innerHTML = list.map((s) => pillHtml(s, expanded)).join("");
      fit(list.length);
    } else {
      const behind = Math.min(2, list.length - 1);
      elStack.innerHTML = `<div class="deck">${pillHtml(list[0], expanded, list.length - 1)}` +
        Array.from({ length: behind }, (_, i) => `<span class="layer l${i + 1}" data-open title="Show every chat"></span>`).join("") + `</div>`;
    }
    // the bell counts the chats you can't see while the pills are hidden; clicking it shows them
    elBadge.hidden = !(sessions.length > 0 && !show);
    if (!elBadge.hidden) {
      const u = urgent(), n = sessions.length;
      const need = sessions.filter((s) => s.status === "waiting" || s.status === "failed").length;
      const working = sessions.filter((s) => s.status === "running").length;
      elBadge.innerHTML = `${ic("bell")}<b>${n}</b>`;
      elBadge.className = "badge" + (u.status === "waiting" ? " warn" : u.status === "failed" ? " bad" : u.status === "review" ? " ok" : "");
      const parts = [n === 1 ? "1 chat" : `${n} chats`, need ? `${need} need${need === 1 ? "s" : ""} you` : "", working ? `${working} working` : ""].filter(Boolean);
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
    const want = sessions.length > 1 && !drag && overPills(x, y, fan ? GAP + 2 : 0);
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

  async function applySettings(next) {
    const first = !S;
    const sizeChanged = first || next.petSize !== S.petSize;
    const petChanged = first || next.activePet !== S.activePet;
    // Settings' "Move to the corner" clears the saved spot
    const reset = !first && next.petX == null && S.petX != null;
    S = next;
    document.body.classList.toggle("shadow", S.shadow !== false);
    if (sizeChanged || reset) { computeDims(); await placeWindow(reset); }
    if (petChanged) await loadPet();
    if (!S.look) player.setLook(null);
    render();
    updateSprite();
  }

  /* ───────── input ───────── */
  const inRect = (el, x, y) => { const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
  // the hover keys can be wider than a small pet, so while they show they count as the pet
  const inPet = (x, y) => inRect(elPet, x, y) || (hoverPet && elTools.offsetParent !== null && inRect(elTools, x, y));

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
  elBadge.addEventListener("pointerdown", (e) => e.stopPropagation());
  elBadge.addEventListener("click", (e) => {
    e.stopPropagation();
    if ((S && S.pill) === "never") invoke("show_main_view", { view: "claude" });
    else { folded = false; render(); }
  });

  elStack.addEventListener("click", (e) => {
    const x = e.target.closest("[data-x]");
    if (x) { invoke("dismiss", { id: x.dataset.x }); return; }
    if (e.target.closest("[data-open]")) { expanded = true; render(); return; }
    if (e.target.closest("[data-app]")) { invoke("show_main_view", { view: "claude" }); return; }
    const p = e.target.closest(".pill");
    if (!p || p.dataset.id === "_idle") return;
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
    on("settings", applySettings);
    on("sessions", setSessions);
    on("pets", (id) => { if (!pet || id === pet.id) loadPet(); });
    new ResizeObserver(() => requestAnimationFrame(sendRects)).observe(elStack);
  })();
})();
