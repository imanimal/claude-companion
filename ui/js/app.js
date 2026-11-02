/* Claude Companion main window: the top bar (it's the title bar), the program keys and four views.
   - Pets: the Codex pets folder as cards with live idle previews; use, edit, duplicate, delete (to the trash, with
     a Deleted panel to restore from), import (files, a pet folder, or a dropped PNG/WebP sheet) and a big preview
     that plays each state like Codex.
   - Editor: editor.js.
   - Claude: the hook bridge, installing the Claude Code hooks and the progress memory, live sessions, test keys.
   - Settings: the pet on the desktop, the app (pulling pets from Codex, updates), and the theme browser (themes.js): switching at night
     with its Day and Night slots, built-in and imported themes as cards, import a file or pasted JSON, export, make
     one with a chatbot.
   Rust events: "pets" (a pet changed), "settings", "sessions", "nav" (open a view), "edit-pet" (open the editor),
   "codex" (a pull of Codex's cloud pets, codex.rs), "update-available", "update-progress" and "update-check" (updater.rs). */
(function () {
  const { $, $$, esc, ic, invoke, on, toast, fail } = CC;
  const SP = CC.sprite, TH = CC.themes;
  const VIEWS = [
    { id: "pets", label: "Pets", icon: "pets" },
    { id: "editor", label: "Editor", icon: "grid" },
    { id: "claude", label: "Claude", icon: "claude" },
    { id: "settings", label: "Settings", icon: "gear" },
  ];
  // status → LCD label and tone
  const STAT = { running: ["Working", ""], waiting: ["Waiting", "hot"], failed: ["Blocked", "bad"], review: ["Done", ""], idle: ["Idle", ""] };
  const PLAY = ["idle", "running", "waiting", "review", "failed", "waving", "jumping", "running-right", "running-left"];
  const LINKS = [
    ["codex-pets", "https://github.com/senyo888/codex-pets"],
    ["codex-custom-pets", "https://github.com/webkubor/codex-custom-pets"],
    ["Show us your pet", "https://community.openai.com/t/show-us-your-custom-codex-pet/1387591"],
  ];
  const A = { view: "pets", pets: [], deleted: [], set: {}, sessions: [], claude: null, memory: "", auto: null, folder: "", showMem: false, big: "idle",
    version: "", update: null, checking: false, paste: "", gen: { idea: "", reply: "", read: null }, slot: null, flash: null };
  const top = $("#top"), view = $("#view");
  let players = [];

  const activePet = () => A.pets.find((p) => p.id === A.set.activePet) || null;
  const label = (state) => (SP.ROWS.find((r) => r.key === state) || { label: state }).label;
  const base = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";

  /* ───────── top bar ───────── */
  function drawTop() {
    const s = A.sessions[0];
    const live = s ? (() => {
      const [lbl, tone] = STAT[s.status] || STAT.idle;
      const pct = s.progress != null ? Math.round(s.progress) + "%" : A.sessions.length;
      return `<div class="display live${tone ? " " + tone : ""}" title="${esc(s.title || "Claude")}"><span class="d-lbl">${lbl}</span><span class="d-num">${pct}</span></div>`;
    })() : "";
    top.innerHTML = `<span class="brandmark"><span class="logo">${ic("paw")}</span><span class="nm">Claude Companion</span></span>
      <nav class="nkeys" role="tablist" aria-label="Views">${VIEWS.map((v) => {
        const ct = v.id === "claude" && A.sessions.length ? `<span class="ct">${A.sessions.length}</span>` : "";
        return `<button class="nv${A.view === v.id ? " on" : ""}" data-view="${v.id}" role="tab" aria-selected="${A.view === v.id}">${ic(v.icon)}<span class="lb">${v.label}</span>${ct}</button>`;
      }).join("")}</nav>
      <span class="sp"></span>${live}
      <button class="btn sm tg" data-act="toggle-pet" title="${A.set.petVisible ? "Hide" : "Show"} the pet on the desktop" aria-label="${A.set.petVisible ? "Hide pet" : "Show pet"}">${ic("eye")}<span class="lb">${A.set.petVisible ? "Hide pet" : "Show pet"}</span></button>
      ${CC.winKeys()}`;
  }

  function nav(v, force) {
    if (!VIEWS.some((x) => x.id === v) || (v === A.view && !force)) return;
    A.view = v;
    A.slot = null;
    theme();
    drawTop();
    drawView();
  }
  function drawView() {
    players.forEach((p) => p.stop());
    players = [];
    if (A.view !== "editor") CC.editor.leave();
    view.dataset.page = A.view;
    ({ pets: drawPets, editor: () => CC.editor.mount(view), claude: drawClaude, settings: drawSettings })[A.view]();
  }
  function player(el, info, state) {
    const p = new SP.Player(el);
    p.setPet(SP.model(info));
    if (state && state !== "idle") p.play(state, { force: true });
    players.push(p);
    return p;
  }

  /* ───────── pets ───────── */
  // pets pulled from Codex (codex.rs), which can take Codex's art again
  const fromCodex = (id) => A.set.codexSync && Object.values(A.set.codexPets || {}).some((l) => l.pet === id);
  function cardHtml(p) {
    const m = SP.model(p), onDesk = p.id === A.set.activePet;
    const tags = (m.valid ? `<span class="tag">v${m.version}</span>` : `<span class="tag bad" title="Codex needs 1536×1872 or 1536×2288">${p.width}×${p.height}</span>`) +
      (onDesk ? `<span class="tag acc">On desktop</span>` : "");
    return `<article class="pcard${onDesk ? " on" : ""}" data-id="${esc(p.id)}">
      <div class="stage-well checker" data-hop title="Hover to jump, click to wave"><div class="sprite" data-pet="${esc(p.id)}"></div></div>
      <div class="nm" title="${esc(m.name)}">${esc(m.name)}</div>
      <div class="ds">${esc(m.description || "No description")}</div>
      <div class="tags">${tags}</div>
      <div class="actions">
        ${onDesk ? "" : `<button class="btn sm primary" data-act="use">${ic("paw")} Use</button>`}
        <button class="btn sm" data-act="edit">${ic("edit")} Edit</button>
        <button class="btn sm icon" data-act="dup" title="Duplicate" aria-label="Duplicate">${ic("copy")}</button>
        <button class="btn sm icon" data-act="reveal" title="Show in folder" aria-label="Show in folder">${ic("folder")}</button>
        ${fromCodex(p.id) ? `<button class="btn sm icon" data-act="codex-update" title="Update from Codex" aria-label="Update from Codex">${ic("down")}</button>` : ""}
        <button class="btn sm icon" data-act="del" title="Delete" aria-label="Delete">${ic("trash")}</button>
      </div>
    </article>`;
  }
  function drawPets() {
    const act = activePet();
    const am = act && SP.model(act);
    view.innerHTML = `<div class="cols">
      <section class="panel">
        <div class="ph"><span class="pt">${ic("pets")} Pets</span><span class="cnt">${A.pets.length} in ${esc(A.folder || "~/.codex/pets")}</span><span class="sp"></span>
          <button class="btn ghost sm" data-act="import">${ic("plus")} Import</button><button class="btn ghost sm" data-act="folder">${ic("folder")} Folder</button></div>
        <div class="pb">${A.pets.length ? `<div class="pgrid">${A.pets.map(cardHtml).join("")}</div>` :
          `<div class="m-empty">${ic("pets", "big")}<b>No pets yet</b><span>Drop a Codex pet folder or spritesheet here, or import one.</span><div class="actions"><button class="btn primary" data-act="import">${ic("plus")} Import a pet</button></div></div>`}</div>
      </section>
      <div class="stackcol">
        <section class="panel">
          <div class="ph"><span class="pt">${ic("eye")} On desktop</span><span class="cnt">${act ? esc(am.name) : ""}</span><span class="sp"></span>
            ${act ? `<button class="btn ghost sm" data-act="edit" data-id="${esc(act.id)}">${ic("edit")} Edit</button>` : ""}</div>
          <div class="pb">${act ? `
            <div class="stage-well checker big-stage"><div class="sprite" id="bigSprite"></div></div>
            <div class="grp">Play a state</div>
            <div class="statechips">${PLAY.map((s) => `<button class="chip${A.big === s ? " on" : ""}" data-state="${s}">${esc(label(s))}</button>`).join("")}</div>
            <p class="note">States play three times, then the pet settles into its slow idle, as in Codex.${am.valid ? "" : " This sheet isn't a Codex size, so Codex won't show it; open it in the editor and save to fix that."}</p>` :
            `<div class="m-empty">${ic("paw", "big")}<b>No pet on the desktop</b><span>Pick one with Use.</span></div>`}</div>
        </section>
        <section class="panel">
          <div class="ph"><span class="pt">${ic("plus")} Add a pet</span></div>
          <div class="pb">
            <div class="dropzone">${ic("image", "big")}<div><b class="hi">Drop a Codex pet here</b></div><div>A pet folder, its pet.json with the sheet, or just a PNG or WebP sheet</div>
              <div class="actions" style="justify-content:center;margin-top:.6em"><button class="btn sm" data-act="import">Choose files</button></div></div>
            <div class="grp">Find pets</div>
            <div class="actions">${LINKS.map(([t, u]) => `<button class="btn sm ghost" data-url="${esc(u)}">${ic("ext")} ${esc(t)}</button>`).join("")}</div>
            <p class="note">Codex and Claude Companion share this folder, so pets added here show up in Codex too.</p>
          </div>
        </section>
        ${A.deleted.length ? `<section class="panel">
          <div class="ph"><span class="pt">${ic("trash")} Deleted</span><span class="cnt">${A.deleted.length}</span><span class="sp"></span>
            <button class="btn ghost sm" data-act="trash-empty">Empty</button></div>
          <div class="pb">${A.deleted.map((d) => `<div class="srow2">${ic("pets")}<div class="st"><b>${esc(d.displayName)}</b><span>Deleted ${esc(CC.ago(d.at))}</span></div>
            <button class="btn sm" data-act="restore" data-key="${esc(d.key)}">${ic("undo")} Restore</button></div>`).join("")}</div>
        </section>` : ""}
      </div>
    </div>`;
    view.querySelectorAll(".sprite[data-pet]").forEach((el) => {
      const p = A.pets.find((x) => x.id === el.dataset.pet);
      if (p) el._player = player(el, p);
    });
    const big = $("#bigSprite");
    if (big && act) player(big, act, A.big);
  }

  // quiet: the window came back, so redraw only if the folder changed (pets added or edited by Codex or by hand)
  async function loadPets(quiet) {
    let list = A.pets, gone = A.deleted;
    try { [list, gone] = await Promise.all([invoke("list_pets"), invoke("deleted_pets")]); } catch (e) { /* web preview */ }
    if (quiet === true && JSON.stringify([list, gone]) === JSON.stringify([A.pets, A.deleted])) return;
    A.pets = list;
    A.deleted = gone;
    if (A.view === "pets") drawPets();
    CC.editor.petsChanged();
  }
  async function setSettings(patch) {
    try { applySettings(await invoke("set_settings", { patch })); } catch (e) { fail(e); }
  }
  // the theme follows the settings and, while night is on, the system; in Settings it's the selected slot's, a preview
  // when that slot isn't the one in effect. A new look redraws (its icons differ).
  // Sprites here are smoothed like the pet unless "Smooth edges" is off.
  function theme() {
    document.body.classList.toggle("smooth", A.set.smooth !== false);
    const look = document.documentElement.dataset.look;
    TH.apply(A.view === "settings" ? slotTheme(slotOf()) : TH.pick(A.set));
    return look !== document.documentElement.dataset.look;
  }
  // the pet's spot and size change while it's dragged or sized: nothing to redraw but the size slider
  const QUIET = ["petX", "petY", "petScale"];
  function applySettings(s) {
    const was = A.set || {}, before = JSON.stringify(was);
    A.set = s || {};
    if (!two()) A.slot = null;
    const relook = theme();
    if (before === JSON.stringify(A.set) && !relook) return;
    const keys = Object.keys(Object.assign({}, was, A.set));
    if (!relook && keys.every((k) => QUIET.includes(k) || JSON.stringify(was[k]) === JSON.stringify(A.set[k]))) return syncSize();
    drawTop();
    if (relook || A.view === "pets" || A.view === "settings") drawView();
  }

  /* Import: a pet folder (pet.json + sheet), the two files, or a sheet on its own. */
  async function importFiles(files) {
    files = Array.from(files || []);
    const img = files.find((f) => /\.(png|webp)$/i.test(f.name) || /^image\/(png|webp)$/.test(f.type));
    const js = files.find((f) => /\.json$/i.test(f.name));
    if (!img) return toast("Pick a PNG or WebP spritesheet, with its pet.json if you have one", { bad: true });
    let manifest = {};
    if (js) {
      try { manifest = JSON.parse(await js.text()); } catch (e) { return toast("That pet.json isn't valid JSON", { bad: true }); }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) manifest = {};
    }
    delete manifest.id;
    delete manifest.spritesheetPath;
    const stem = img.name.replace(/\.[^.]+$/, "");
    const name = (manifest.displayName || (/^spritesheet$/i.test(stem) ? img.folder || "New pet" : stem.replace(/[-_]+/g, " "))).trim();
    let size = null;
    try { const b = await createImageBitmap(img); size = [b.width, b.height]; b.close && b.close(); } catch (e) { /* the app checks it */ }
    try {
      const info = await CC.writePet({ mode: "create", name, manifest, ext: /webp/i.test(img.type) || /\.webp$/i.test(img.name) ? "webp" : "png" }, await img.arrayBuffer());
      await loadPets();
      const ok = size && SP.formatFor(size[0], size[1]);
      // the first pet goes straight onto the empty desktop
      if (ok && !activePet()) {
        await setSettings({ activePet: info.id });
        return toast(`Added ${info.displayName}. It's on the desktop now.`);
      }
      toast(ok ? `Added ${info.displayName}` : `Added ${info.displayName}. Its sheet is ${size ? size.join("×") : "an unusual size"}; save it from the editor to make it a Codex size.`,
        { action: ok ? "Use it" : "Edit", onAction: () => (ok ? setSettings({ activePet: info.id }) : editPet(info.id)), ms: ok ? 5000 : 8000 });
    } catch (e) { fail(e); }
  }
  /* Dropped folders come through as entries; read one level and tag files with the folder's name. */
  async function dropped(dt) {
    const out = [];
    const entries = Array.from(dt.items || []).map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return Array.from(dt.files || []);
    const file = (en) => new Promise((res) => en.file(res, () => res(null)));
    for (const en of entries) {
      if (en.isFile) { const f = await file(en); if (f) out.push(f); continue; }
      const list = await new Promise((res) => en.createReader().readEntries(res, () => res([])));
      for (const c of list) if (c.isFile) { const f = await file(c); if (f) { f.folder = en.name; out.push(f); } }
    }
    return out;
  }
  async function duplicate(id) {
    const p = A.pets.find((x) => x.id === id);
    if (!p) return;
    try {
      const bytes = await (await fetch(SP.model(p).url)).arrayBuffer();
      const man = JSON.parse(JSON.stringify(p.manifest || {}));
      delete man.id;
      delete man.spritesheetPath;
      man.displayName = (p.displayName || p.id) + " copy";
      const info = await CC.writePet({ mode: "create", name: man.displayName, manifest: man, ext: /\.webp$/i.test(p.sheet) ? "webp" : "png" }, bytes);
      await loadPets();
      toast(`Made ${info.displayName}`, { action: "Edit", onAction: () => editPet(info.id) });
    } catch (e) { fail(e); }
  }
  // deleted pets go to the trash (pets.rs), so a delete needs no asking; emptying it does, with a second click
  function restorePet(key) {
    invoke("restore_pet", { key }).then((p) => toast(`Restored ${p.displayName}`), fail);
  }
  function emptyTrash(b) {
    if (!b.dataset.sure) {
      b.dataset.sure = "1";
      b.textContent = `Delete ${A.deleted.length === 1 ? "it" : `all ${A.deleted.length}`} for good?`;
      setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = "Empty"; } }, 4000);
      return;
    }
    invoke("empty_trash").then(() => toast("Trash emptied"), fail);
  }
  function editPet(id) {
    CC.editor.edit(id);
    nav("editor");
  }

  /* ───────── claude ───────── */
  async function refreshClaude() {
    try {
      A.claude = await invoke("claude_status");
      if (!A.memory) A.memory = await invoke("memory_text");
    } catch (e) { /* web preview */ }
    const el = $("#setup");
    if (el && A.view === "claude") el.innerHTML = setupHtml();
  }
  function setupHtml() {
    const c = A.claude;
    if (!c) return `<div class="m-empty">${ic("claude", "big")}<b>${CC.live ? "Checking Claude Code…" : "Open Claude Companion to set up Claude Code"}</b></div>`;
    const hooksTag = c.hooks ? `<span class="tag ok">Installed</span>` : c.hooksElsewhere ? `<span class="tag warn">Points to another copy</span>` : `<span class="tag">Not installed</span>`;
    return `
      <div class="srow2">${ic("bolt")}<div class="st"><b>Bridge ${c.bridgeError ? `<span class="tag bad">Off</span>` : `<span class="tag ok">Listening</span>`}</b>
        <span>${c.bridgeError ? esc(c.bridgeError) : `On 127.0.0.1:${c.port} · ${c.lastEvent ? "last hook " + CC.ago(c.lastEvent) : "no hook events yet"}`}</span></div><span></span></div>
      <div class="srow2">${ic("link")}<div class="st"><b>Hooks ${hooksTag}</b>
        <span>Claude Code tells the pet when a turn starts, a tool runs, it needs you, and when it's done. Sessions started after you install pick them up.</span>
        <span class="path">${esc(c.settingsPath)}</span></div>
        <div class="actions">${c.hooks ? `<button class="btn sm" data-act="hooks-off">Remove</button>` : `<button class="btn sm primary" data-act="hooks-on">${ic("plus")} ${c.hooksElsewhere ? "Point here" : "Install"}</button>`}</div></div>
      <div class="srow2">${ic("claude")}<div class="st"><b>Progress memory ${c.memory ? `<span class="tag ok">On</span>` : `<span class="tag">Off</span>`}</b>
        <span>A note in your global CLAUDE.md asks Claude to send a rough progress estimate with its first tool call each turn. The pet shows it as the bar.</span>
        <span class="path">${esc(c.memoryPath)}</span></div>
        <div class="actions"><button class="btn sm ghost" data-act="mem-show">${A.showMem ? "Hide text" : "Show text"}</button>${c.memory ? `<button class="btn sm" data-act="mem-off">Remove</button>` : `<button class="btn sm primary" data-act="mem-on">${ic("plus")} Add</button>`}</div>
        ${A.showMem ? `<pre>${esc(A.memory)}</pre>` : ""}</div>
      <div class="srow2">${ic("play")}<div class="st"><b>Try it</b><span>Send the pet a pretend session to see each pill.</span></div>
        <div class="actions">${[["running", "Working"], ["waiting", "Needs input"], ["review", "Ready"], ["failed", "Blocked"], ["clear", "Clear"]].map(([k, l]) => `<button class="btn sm${k === "clear" ? " ghost" : ""}" data-test="${k}">${l}</button>`).join("")}</div></div>`;
  }
  function sessHtml(s) {
    const [lbl, tone] = STAT[s.status] || STAT.idle;
    const pct = s.progress != null ? Math.round(s.progress) : null;
    const where = [s.step, base(s.cwd), CC.ago(s.updatedAt)].filter(Boolean).map(esc).join(" · ");
    // like a pill on the pet: chats the desktop app started open there, terminal chats open the app
    const tip = [s.title, s.subtitle, s.hostSession ? "Click to open this chat in Claude" : "Click to open Claude"].filter(Boolean).join("\n");
    return `<div class="sess${s.status === "review" ? " done" : ""}"><div class="display${tone ? " " + tone : ""}"><span class="d-lbl">${lbl}</span><span class="d-num">${pct != null ? pct + "%" : "··"}</span>${pct != null ? `<span class="d-bar"><i style="width:${pct}%"></i></span>` : ""}</div>
      <button class="so" data-act="open-chat" data-id="${esc(s.id)}" title="${esc(tip)}"><span class="t">${esc(s.title || "Claude")}</span><span class="s">${esc(s.subtitle || "")}</span><span class="w">${where}</span></button>
      <button class="btn ghost sm icon" data-act="dismiss" data-id="${esc(s.id)}" title="Dismiss" aria-label="Dismiss">${ic("close")}</button></div>`;
  }
  function drawSessions() {
    const el = $("#sessList"), ct = $("#sessCnt");
    if (!el) return;
    if (ct) ct.textContent = A.sessions.length ? `${A.sessions.length} active` : "";
    el.innerHTML = A.sessions.length ? A.sessions.map(sessHtml).join("") :
      `<div class="m-empty">${ic("claude", "big")}<b>No sessions right now</b><span>Start a Claude Code session; it shows up here and on the pet.</span></div>`;
  }
  function drawClaude() {
    view.innerHTML = `<div class="cols claude">
      <section class="panel"><div class="ph"><span class="pt">${ic("claude")} Claude Code</span><span class="sp"></span><button class="btn ghost sm" data-act="open-claude">${ic("ext")} Open Claude</button></div>
        <div class="pb setup" id="setup">${setupHtml()}</div></section>
      <section class="panel"><div class="ph"><span class="pt">${ic("bolt")} Sessions</span><span class="cnt" id="sessCnt"></span></div><div class="pb" id="sessList"></div></section>
    </div>`;
    drawSessions();
    refreshClaude();
  }
  async function setup(what, on) {
    try { A.claude = await invoke("claude_setup", { what, on }); } catch (e) { fail(e); }
    const el = $("#setup");
    if (el) el.innerHTML = setupHtml();
    if (A.claude) {
      if (what === "hooks") toast(on ? "Hooks installed. New Claude Code sessions report to the pet." : "Hooks removed");
      else toast(on ? "Progress memory added to your CLAUDE.md" : "Progress memory removed");
    }
  }

  /* ───────── settings ───────── */
  const seg = (k, opts, label) => `<div class="seg" role="group"${label ? ` aria-labelledby="${label}"` : ""}>${opts.map(([v, l]) => `<button class="chip${A.set[k] === v ? " on" : ""}" data-seg="${k}" data-v="${v}">${l}</button>`).join("")}</div>`;
  const chk = (k, l) => `<label class="check"><input type="checkbox" data-chk="${k}"${A.set[k] ? " checked" : ""}> ${l}</label>`;
  // petScale is the pet's width as a share of Codex's (pet.js); the slider shows it as a percentage
  const petPct = () => Math.round((+A.set.petScale || 1) * 100);
  function syncSize() {
    const r = $("#petScale"), v = $("#petScaleVal");
    if (!r || A.sizing) return;
    r.value = petPct();
    v.textContent = petPct() + "%";
  }
  // the slider sizes the pet as it moves, at most once a frame
  let sizeNext = null;
  function sendSize(pct) {
    const queued = sizeNext != null;
    sizeNext = pct;
    if (!queued) requestAnimationFrame(() => { const v = sizeNext; sizeNext = null; setSettings({ petScale: v / 100 }); });
  }
  function drawSettings() {
    // a redraw (a theme picked, a switch flipped) keeps the scroll position
    const was = $(".cols.settings"), keep = was ? was.scrollTop : 0;
    A.sizing = false;
    view.innerHTML = `<div class="cols settings">
      <section class="panel"><div class="ph"><span class="pt">${ic("paw")} Pet on the desktop</span></div><div class="pb"><div class="fgrid">
        <label>Pet</label><div>${CC.windows ? `<div class="chks">${chk("petVisible", "Show the pet")}${chk("hideFullscreen", "Hide while an app is fullscreen")}</div><div class="note" style="margin-top:.35em">Videos, games and slideshows on the pet's screen. It comes back when they end.</div>` : chk("petVisible", "Show the pet")}</div>
        <label>Size</label><div><div class="size"><input type="range" id="petScale" min="50" max="200" step="1" value="${petPct()}" aria-label="Pet size"><span class="val" id="petScaleVal">${petPct()}%</span><button class="btn ghost sm" data-act="size-codex" title="Back to Codex's size">Reset</button></div><div class="note" style="margin-top:.35em">100% is Codex's size. You can also ${CC.mac ? "pinch or hold ⌘ and scroll" : "hold Ctrl and scroll"} over the pet, or right-click it.</div></div>
        <label>Pills</label><div>${seg("pill", [["auto", "For updates"], ["always", "Always"], ["never", "Never"]])}<div class="note" style="margin-top:.35em">Never leaves a count badge on the pet instead.</div></div>
        <label>Collegiapp</label><div>${chk("countdowns", "Count down to classes and deadlines")}<div class="note" style="margin-top:.35em">A class shows an hour before it starts and work a day before it's due, always behind your Claude chats. Click one to open Collegiapp; the x hides it.</div><div class="note" id="cdStatus" style="margin-top:.35em"></div><button class="btn sm" data-act="cd-preview" style="margin-top:.4em">${ic("play")} Preview for a minute</button></div>
        <label>Motion</label><div class="chks">${chk("hoverJump", "Jump when the cursor is on the pet")}${chk("look", "Look toward the cursor (v2 pets)")}</div>
        <label>Shadow</label><div>${chk("shadow", "Drop shadow under the pet")}</div>
        <label>Edges</label><div>${chk("smooth", "Smooth edges")}<div class="note" style="margin-top:.35em">Off draws the pet pixelated, like Codex, which suits pixel-art pets.</div></div>
        <label>Position</label><div><button class="btn sm" data-act="reset-pos">Move to the corner</button></div>
      </div></div></section>
      <section class="panel"><div class="ph"><span class="pt">${ic("gear")} App</span></div><div class="pb"><div class="fgrid">
        <label>Startup</label><div><label class="check"><input type="checkbox" data-auto${A.auto ? " checked" : ""}> Start with ${CC.mac ? "macOS" : "Windows"}, pet only</label></div>
        <label>Pets folder</label><div><div class="path">${esc(A.folder)}</div><button class="btn sm" data-act="folder" style="margin-top:.4em">${ic("folder")} Show folder</button></div>
        <label>Codex</label><div>${chk("codexSync", "Pull my pets from Codex")}<div class="note" style="margin-top:.35em">Codex keeps the pets you make in your ChatGPT account, not in this folder. This copies them in from Codex's own files on this computer and brings new art over when a pet changes. Nothing is downloaded.</div><div class="note" id="codexStatus" style="margin-top:.35em"></div>${A.set.codexSync ? `<button class="btn sm" data-act="codex-pull" style="margin-top:.4em">${ic("down")} Pull now</button>` : ""}</div>
        <label>Updates</label><div><div class="note" id="updStatus">${esc(updateStatus())}</div><div class="actions" style="margin-top:.4em">
          ${A.update ? `<button class="btn sm primary" data-act="update-install">${ic("down")} Install ${esc(A.update.version)}</button>` : ""}<button class="btn sm" data-act="update-check">Check for updates</button></div></div>
      </div></div></section>
      ${themesHtml()}
    </div>`;
    $(".cols.settings").scrollTop = keep;
    drawCountdownStatus();
    drawCodexStatus();
  }
  async function drawCodexStatus() {
    const st = await invoke("codex_status").catch(() => null);
    const el = $("#codexStatus");
    if (!el) return;
    const n = st ? st.cloud : 0;
    el.innerHTML = !A.set.codexSync || !st ? "" :
      !st.found ? `Codex isn't on this computer yet. Looking for <span class="path">${esc(st.path)}</span>` :
      st.error ? `Couldn't pull from Codex: ${esc(st.error)}` :
      !n ? "No pets in your Codex account yet." :
      st.waiting ? `${st.waiting} of your ${n} Codex pets will come over once Codex has shown them.` :
      `Up to date with the ${n} ${n === 1 ? "pet" : "pets"} in your Codex account.`;
  }
  // a pull that added or redrew pets says which
  function onCodex(st) {
    if (A.view === "settings") drawCodexStatus();
    const names = (st && st.pulled) || [];
    if (!names.length) return;
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    toast(`From Codex: ${list}`);
  }
  async function drawCountdownStatus() {
    const st = await invoke("countdown_status").catch(() => null);
    const el = $("#cdStatus");
    if (!el || !st) return;
    const n = st.shown;
    el.innerHTML = !A.set.countdowns ? "" :
      !st.found ? `Collegiapp's data isn't on this computer yet. Looking for <span class="path">${esc(st.path)}</span>` :
      st.error ? `Couldn't read Collegiapp's data: ${esc(st.error)}` :
      n ? `${n} coming up now.` : "Nothing coming up right now.";
  }

  /* ───────── themes (themes.js) ───────── */
  /* With "Switch theme at night" on, a Day and a Night slot sit over the grid, and a click puts a theme in the selected
     one. The selection starts on the slot in effect (TH.slotNow); selecting the other previews its theme in this window
     (never the pet) until it's deselected, Settings closes or the window hides. Off is one theme and no slots. */
  const two = () => A.set.night !== "off";
  const slotOf = () => (two() ? A.slot || TH.slotNow(A.set) : "day");
  const slotTheme = (k) => (k === "night" ? TH.nightOf(A.set) : TH.dayOf(A.set));
  const SLOT = { day: ["sun", "Day"], night: ["moon", "Night"] };
  function selectSlot(k) {
    if (k === slotOf()) return;
    A.slot = k;
    theme();
    drawTop();
    drawView();
    const el = $(`.tslot[data-slot="${k}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  // flash: the slot whose theme just changed, whose preview pops in
  function slotHtml(k, flash) {
    const t = slotTheme(k), on = slotOf() === k, now = TH.slotNow(A.set) === k, [icon, name] = SLOT[k];
    return `<button class="tslot${on ? " on" : ""}${flash === k ? " flash" : ""}" role="tab" id="tslot-${k}" data-slot="${k}" aria-selected="${on}" aria-controls="tgrid" tabindex="${on ? 0 : -1}" aria-label="${name}: ${esc(t.name)}${now ? ", now" : ""}">
      ${TH.preview(t)}<span class="tsk">${ic(icon)}${name}${now ? `<span class="tag acc">Now</span>` : ""}</span><span class="tn">${esc(t.name)}</span></button>`;
  }
  // the selected slot's theme gets the ring; the other slot's gets a quiet sun or moon
  function themeCard(t, preview) {
    const k = slotOf(), other = k === "day" ? "night" : "day", on = !preview && slotTheme(k).id === t.id, low = TH.checks(t.tokens).length;
    const mark = !preview && two() && slotTheme(other).id === t.id ? `<span class="tmark" role="img" title="Your ${other} theme" aria-label="Your ${other} theme">${ic(SLOT[other][0], "sm")}</span>` : "";
    const tags = `<span class="tag">${t.look === "pocket" ? "Pocket" : "Standard"}</span>${t.scheme === "dark" ? `<span class="tag">Dark</span>` : ""}` +
      (low ? `<span class="tag warn">Low contrast</span>` : "");
    const acts = preview || t.builtin ? "" : `<button class="btn ghost sm icon" data-act="theme-del" data-id="${esc(t.id)}" title="Delete this theme" aria-label="Delete this theme">${ic("trash")}</button>`;
    return `<div class="tcard${on ? " on" : ""}">
      <button class="tpick"${preview ? " disabled" : ` data-act="theme-use" data-id="${esc(t.id)}" aria-pressed="${on}"`}>${TH.preview(t)}<span class="tnr"><span class="tn">${esc(t.name)}</span>${mark}</span></button>
      <div class="tags">${tags}</div><div class="ds">${esc(t.note || (t.by ? "By " + t.by : ""))}</div>${acts ? `<div class="actions">${acts}</div>` : ""}</div>`;
  }
  function readHtml(r) {
    if (r.error) return `<p class="note bad">${esc(r.error)}</p>`;
    return `<div class="tread">${themeCard(r.theme, true)}<div>
      <p class="note">${esc(r.warnings.join(" ") || "Every pair reads well.")}</p>
      <div class="actions">${r.lowContrast ? `<button class="btn sm primary" data-act="save-gen" data-fix="1">Fix contrast and save</button>` : ""}<button class="btn sm${r.lowContrast ? " ghost" : " primary"}" data-act="save-gen">${r.lowContrast ? "Save as it is" : "Save and use it"}</button></div></div></div>`;
  }
  function themesHtml() {
    const g = A.gen, k = slotOf(), shown = slotTheme(k), flash = A.flash;
    A.flash = null;
    return `<section class="panel themes"><div class="ph"><span class="pt">${ic("palette")} Themes</span><span class="cnt">${k === TH.slotNow(A.set) ? "" : "Previewing "}${esc(shown.name)}</span><span class="sp"></span>
        <button class="btn ghost sm" data-act="theme-export" title="Save ${esc(shown.name)} as a file to share">${ic("save")} Export</button></div>
      <div class="pb">
        <div class="tnight"><span class="tq" id="tq">Switch theme at night</span>${seg("night", [["auto", "Follow the system"], ["off", "Off"]], "tq")}</div>
        ${two() ? `<p class="note">Night is whenever ${osName()} is in dark mode. Choose Day or Night, then click a theme to put it there.</p>
        <div class="tslots" role="tablist" aria-label="Theme slots">${slotHtml("day", flash)}${slotHtml("night", flash)}</div>` : ""}
        <div class="grp" id="tgh">${two() ? `Pick a ${k} theme` : "Pick a theme"}</div>
        <div class="tgrid" id="tgrid"${two() ? ` role="tabpanel" aria-labelledby="tgh"` : ""}>${TH.all(A.set).map((t) => themeCard(t)).join("")}</div>
        <p class="note">Claude themes follow the Claude desktop app, Pocket themes are the handheld look from Collegiapp, and Standard themes are plain and flat. Theme files work in Collegiapp and PocketCanvas too.</p>
        <div class="tmake">
          <div><div class="grp">Import a theme</div>
            <p class="note">A theme file from Collegiapp, PocketCanvas or a friend, or its JSON pasted here.</p>
            <textarea data-f="paste" rows="4" placeholder='{"pocketTheme":1,"name":"…","tokens":{…}}'>${esc(A.paste)}</textarea>
            <div class="actions"><button class="btn sm" data-act="theme-paste">Import</button><button class="btn sm" data-act="theme-file">${ic("folder")} Choose a file</button></div></div>
          <div><div class="grp">Make one with a chatbot</div>
            <p class="note">Describe it, open a chatbot with the prompt filled in, then paste its reply here. Claude Companion checks the contrast and can fix it.</p>
            <input type="text" data-f="idea" placeholder="Matcha latte and an old Game Boy" value="${esc(g.idea)}">
            <div class="actions"><button class="btn sm primary" data-act="bot" data-bot="claude">${ic("ext")} Open Claude</button><button class="btn sm" data-act="bot" data-bot="chatgpt">${ic("ext")} Open ChatGPT</button><button class="btn sm ghost" data-act="copy-prompt">${ic("copy")} Copy the prompt</button></div>
            <textarea data-f="reply" rows="4" placeholder="Paste the chatbot's reply">${esc(g.reply)}</textarea>
            <div class="actions"><button class="btn sm" data-act="read-reply">Read the reply</button></div>
            ${g.read ? readHtml(g.read) : ""}</div>
        </div>
      </div></section>`;
  }
  const mine = () => (A.set.themes || []).filter((t) => t && typeof t === "object");
  const osName = () => (CC.mac ? "macOS" : "Windows");
  const slotKey = (k) => (k === "night" ? "nightTheme" : "theme");
  /* A click puts the theme in the selected slot (with night off, the one theme) and nothing else. What shows always
     changes: it's in effect, or it's the selected slot's preview. */
  async function useTheme(id) {
    const k = slotOf();
    if (slotTheme(k).id === id) return;
    A.flash = k;
    await setSettings({ [slotKey(k)]: id });
    A.flash = null;
    const el = $(`.tpick[data-id="${CSS.escape(id)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  // a saved theme goes in the selected slot too
  async function saveTheme(t, note) {
    const k = slotOf();
    A.flash = k;
    await setSettings({ themes: mine().filter((x) => x.id !== t.id).concat(TH.file(t)), [slotKey(k)]: t.id });
    A.flash = null;
    toast(`Saved ${t.name}` + (two() ? ` as your ${k} theme` : "") + (note ? ". " + note : ""), { ms: note ? 8000 : 4200 });
  }
  /* A file or pasted JSON is saved and used at once, its contrast fixed (the chatbot flow asks first). */
  async function importTheme(text) {
    const r = TH.normalize(text);
    if (r.error) return toast(r.error, { bad: true });
    A.paste = "";
    await saveTheme(r.lowContrast ? TH.fix(r.theme) : r.theme, r.warnings.join(" ") + (r.lowContrast ? " Contrast fixed." : ""));
  }
  async function saveGen(fixIt) {
    const r = A.gen.read;
    if (!r || !r.theme) return;
    A.gen = { idea: A.gen.idea, reply: "", read: null };
    await saveTheme(fixIt ? TH.fix(r.theme) : r.theme);
  }
  function delTheme(id) {
    const gone = mine().find((t) => t.id === id);
    if (!gone) return;
    const undo = { themes: mine(), theme: A.set.theme, nightTheme: A.set.nightTheme };
    const day = TH.all(A.set).find((t) => t.id === A.set.theme && t.id !== id) || TH.BUILTIN[0];
    setSettings({ themes: mine().filter((t) => t.id !== id), theme: day.id, nightTheme: A.set.nightTheme === id ? TH.darkOf(day).id : A.set.nightTheme });
    toast(`Deleted ${gone.name}`, { action: "Undo", onAction: () => setSettings(undo) });
  }
  async function exportTheme() {
    const t = slotTheme(slotOf());
    try {
      const path = await invoke("export_theme", { file: t.id + ".pocket-theme.json", text: JSON.stringify(TH.file(t), null, 2) });
      const dir = path.replace(/[\\/][^\\/]+$/, "");
      toast(`Saved ${base(path)} in ${base(dir)}`, { action: "Show", onAction: () => invoke("reveal", { path: dir }).catch(fail) });
    } catch (e) { fail(e); }
  }

  /* ───────── updates (updater.rs) ───────── */
  // The app checks GitHub in the background and says so once per version; installing restarts it, so it waits for you.
  const updateStatus = () => A.update ? `Version ${A.update.version} is ready. You have ${A.update.current}.` :
    `${A.version ? "Version " + A.version + ". " : ""}Claude Companion looks for new versions every few hours and asks before installing one.`;
  async function checkUpdate() {
    if (!CC.live) return;
    toast("Checking for updates…", { ms: 2500 });
    A.checking = true;
    try {
      const u = await invoke("check_update");
      if (u) { A.update = u; askInstall(); } else toast("Claude Companion is up to date");
    } catch (e) { fail("Couldn't check for updates: " + ((e && e.message) || e)); }
    A.checking = false;
  }
  function onUpdate(u) {
    const fresh = !A.update || A.update.version !== u.version;
    A.update = u;
    if (A.view === "settings") drawView();
    if (fresh && !A.checking) toast(`Claude Companion ${u.version} is ready`, { action: "Install", onAction: askInstall, ms: 12000 });
  }
  async function askInstall() {
    const u = A.update;
    if (!u) return;
    const go = await CC.ask("Update", `Claude Companion ${u.version} is ready (you have ${u.current}). It closes, installs and reopens in a few seconds; your pets and settings stay as they are.`,
      [{ label: "Install and restart", value: true, cls: "primary" }, { label: "Later", value: false }]);
    if (!go) return;
    toast("Downloading the update…", { ms: 8000 });
    invoke("install_update").catch((e) => fail("The update didn't install: " + ((e && e.message) || e)));
  }
  function onUpdateProgress(p) {
    const el = $("#updStatus");
    if (!el) return;
    const pct = p.total ? Math.min(100, Math.round((100 * p.done) / p.total)) : 0;
    el.textContent = pct >= 100 ? "Installing. Claude Companion reopens in a moment." : `Downloading ${pct}%`;
  }

  /* ───────── events ───────── */
  document.addEventListener("click", async (e) => {
    // nav keys (and "Go to pets" style buttons) only; the page container carries data-page, not data-view
    const v = e.target.closest("button[data-view]");
    if (v) return nav(v.dataset.view);
    const u = e.target.closest("[data-url]");
    if (u) return void CC.openUrl(u.dataset.url);
    const st = e.target.closest("[data-state]");
    if (st && A.view === "pets") {
      A.big = st.dataset.state;
      $$(".statechips .chip").forEach((c) => c.classList.toggle("on", c === st));
      const big = $("#bigSprite");
      const p = players.find((x) => x.el === big);
      if (p) p.play(A.big, { force: true });
      return;
    }
    const sg = e.target.closest("[data-seg]");
    if (sg) return setSettings({ [sg.dataset.seg]: sg.dataset.v });
    const sl = e.target.closest("[data-slot]");
    if (sl) return selectSlot(sl.dataset.slot);
    const t = e.target.closest("[data-test]");
    if (t) return void invoke("test_session", { kind: t.dataset.test }).catch(fail);
    const hop = e.target.closest("[data-hop]");
    if (hop) { const s = hop.querySelector(".sprite"); if (s && s._player) s._player.play("waving", { force: true }); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id || (b.closest("[data-id]") || {}).dataset?.id;
    const acts = {
      "toggle-pet": () => setSettings({ petVisible: !A.set.petVisible }),
      use: () => setSettings({ activePet: id }),
      edit: () => editPet(id),
      dup: () => duplicate(id),
      del: () => invoke("delete_pet", { id }).then((d) => toast(`Deleted ${d.displayName}`, { action: "Undo", onAction: () => restorePet(d.key) }), fail),
      restore: () => restorePet(b.dataset.key),
      "trash-empty": () => emptyTrash(b),
      reveal: () => invoke("reveal", { path: (A.pets.find((p) => p.id === id) || {}).folder || A.folder }).catch(fail),
      folder: () => invoke("reveal", { path: A.folder }).catch(fail),
      import: () => $("#importFile").click(),
      "open-claude": () => invoke("open_claude_app").catch(fail),
      "open-chat": () => invoke("open_chat", { id }).catch(fail),
      "hooks-on": () => setup("hooks", true), "hooks-off": () => setup("hooks", false),
      "mem-on": () => setup("memory", true), "mem-off": () => setup("memory", false),
      "mem-show": () => { A.showMem = !A.showMem; const el = $("#setup"); if (el) el.innerHTML = setupHtml(); },
      dismiss: () => invoke("dismiss", { id }).catch(fail),
      "reset-pos": () => setSettings({ petX: null, petY: null }),
      "size-codex": () => setSettings({ petScale: 1 }),
      "cd-preview": () => invoke("preview_countdowns").then(() => toast("Two sample countdowns are on the pet for a minute, behind any Claude chats"), fail),
      "codex-pull": () => invoke("pull_codex").catch(fail),
      "codex-update": () => invoke("update_from_codex", { id }).then((msg) => msg && toast(msg), fail),
      "theme-use": () => useTheme(id),
      "theme-del": () => delTheme(id),
      "theme-export": exportTheme,
      "theme-file": () => $("#themeFile").click(),
      "theme-paste": () => importTheme(A.paste),
      bot: () => CC.openUrl(TH.BOTS[b.dataset.bot](TH.prompt(A.gen.idea))),
      "copy-prompt": () => navigator.clipboard.writeText(TH.prompt(A.gen.idea)).then(() => toast("Prompt copied. Paste it into any chatbot."), () => toast("Couldn't copy the prompt", { bad: true })),
      "read-reply": () => { A.gen.read = TH.normalize(A.gen.reply); drawView(); },
      "save-gen": () => saveGen(!!b.dataset.fix),
      "update-check": checkUpdate,
      "update-install": askInstall,
    };
    if (acts[b.dataset.act]) acts[b.dataset.act]();
  });
  // the Day and Night slots are tabs: the arrow keys switch, Home and End go to Day and Night
  document.addEventListener("keydown", (e) => {
    const sl = e.target.closest && e.target.closest("[data-slot]");
    if (!sl) return;
    const other = sl.dataset.slot === "day" ? "night" : "day";
    const k = { ArrowLeft: other, ArrowRight: other, Home: "day", End: "night" }[e.key];
    if (!k) return;
    e.preventDefault();
    selectSlot(k);
  });
  // the theme fields keep what's typed across redraws
  document.addEventListener("input", (e) => {
    if (e.target.id === "petScale") {
      A.sizing = true;
      $("#petScaleVal").textContent = e.target.value + "%";
      return sendSize(+e.target.value);
    }
    const f = e.target.dataset && e.target.dataset.f;
    if (f === "paste") A.paste = e.target.value;
    else if (f === "idea") A.gen.idea = e.target.value;
    else if (f === "reply") A.gen.reply = e.target.value;
  });
  document.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.chk) return setSettings({ [t.dataset.chk]: t.checked });
    if (t.id === "petScale") { A.sizing = false; return sendSize(+t.value); }
    if (t.hasAttribute("data-auto")) {
      try { A.auto = await invoke("autostart", { on: t.checked }); } catch (err) { fail(err); }
      t.checked = !!A.auto;
    }
  });
  // hovering a card's pet makes it jump, like the pet on the desktop
  document.addEventListener("pointerover", (e) => {
    const hop = e.target.closest("[data-hop]");
    if (!hop || hop.contains(e.relatedTarget)) return;
    const s = hop.querySelector(".sprite");
    if (s && s._player) s._player.play("jumping", { loop: true });
  });
  document.addEventListener("pointerout", (e) => {
    const hop = e.target.closest("[data-hop]");
    if (!hop || hop.contains(e.relatedTarget)) return;
    const s = hop.querySelector(".sprite");
    if (s && s._player) s._player.play("idle");
  });
  // drop a pet anywhere on the Pets view
  window.addEventListener("dragover", (e) => {
    if (A.view !== "pets" || !e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    document.body.classList.add("dropping");
  });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
  window.addEventListener("drop", async (e) => {
    document.body.classList.remove("dropping");
    if (A.view !== "pets" || !e.dataTransfer) return;
    e.preventDefault();
    importFiles(await dropped(e.dataTransfer));
  });

  async function boot() {
    CC.bindFrame(top);
    const file = document.createElement("input");
    file.type = "file"; file.id = "importFile"; file.multiple = true; file.hidden = true;
    file.accept = ".png,.webp,.json,image/png,image/webp,application/json";
    file.addEventListener("change", () => { const fs = Array.from(file.files || []); file.value = ""; if (fs.length) importFiles(fs); });
    document.body.appendChild(file);
    const tf = document.createElement("input");
    tf.type = "file"; tf.id = "themeFile"; tf.hidden = true; tf.accept = ".json,application/json";
    tf.addEventListener("change", async () => { const f = tf.files && tf.files[0]; tf.value = ""; if (f) importTheme(await f.text()); });
    document.body.appendChild(tf);
    CC.editor.init({ pets: () => A.pets, activeId: () => A.set.activePet });
    try {
      [A.pets, A.set, A.sessions, A.folder] = await Promise.all([invoke("list_pets"), invoke("get_settings"), invoke("get_sessions"), invoke("pets_folder")]);
      A.auto = await invoke("autostart", {});
      A.version = await window.__TAURI__.app.getVersion();
    } catch (e) { /* web preview */ }
    theme();
    // the system going light or dark (Settings moves its Now tag); checked again on focus, in case the change came
    // while the window was hidden
    let dark = TH.darkMQ.matches;
    const follow = () => {
      if (dark === TH.darkMQ.matches) return;
      dark = TH.darkMQ.matches;
      if (theme() || A.view === "settings") { drawTop(); drawView(); }
    };
    TH.darkMQ.addEventListener("change", follow);
    window.addEventListener("focus", follow);
    // hiding the window (to the tray, or minimized) drops a slot's preview
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden || !A.slot) return;
      A.slot = null;
      if (theme() || A.view === "settings") { drawTop(); drawView(); }
    });
    drawTop();
    drawView();
    on("nav", (v) => nav(v));
    on("edit-pet", (id) => editPet(id));
    on("pets", () => loadPets());
    window.addEventListener("focus", () => loadPets(true));
    on("settings", applySettings);
    on("countdowns", () => { if (A.view === "settings") drawCountdownStatus(); });
    on("codex", onCodex);
    on("update-available", onUpdate);
    on("update-progress", onUpdateProgress);
    on("update-check", checkUpdate);
    on("sessions", (list) => {
      A.sessions = list || [];
      drawTop();
      if (A.view === "claude") drawSessions();
    });
    // keep "x min ago" and the bridge's last hook current
    setInterval(() => { if (A.view === "claude" && !document.hidden) { drawSessions(); refreshClaude(); } }, 5000);
  }
  boot();
})();
