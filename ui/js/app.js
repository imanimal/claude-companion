/* Claude Companion main window: the top bar (it's the title bar), the program keys and four views.
   - Pets: the Codex pets folder as cards with live idle previews; use, edit, duplicate, import (files, a pet
     folder, or a dropped PNG/WebP sheet) and a big preview that plays each state like Codex.
   - Editor: editor.js.
   - Claude: the hook bridge, installing the Claude Code hooks and the progress memory, live sessions, test keys.
   - Settings: the pet on the desktop and the app.
   Rust events: "pets" (a pet changed), "settings", "sessions", "nav" (open a view), "edit-pet" (open the editor). */
(function () {
  const { $, $$, esc, ic, invoke, on, toast, fail } = CC;
  const SP = CC.sprite;
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
  const A = { view: "pets", pets: [], set: {}, sessions: [], claude: null, memory: "", auto: null, folder: "", showMem: false, big: "idle" };
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
      </div>
    </div>`;
    view.querySelectorAll(".sprite[data-pet]").forEach((el) => {
      const p = A.pets.find((x) => x.id === el.dataset.pet);
      if (p) el._player = player(el, p);
    });
    const big = $("#bigSprite");
    if (big && act) player(big, act, A.big);
  }

  async function loadPets() {
    try { A.pets = await invoke("list_pets"); } catch (e) { /* web preview */ }
    if (A.view === "pets") drawPets();
    CC.editor.petsChanged();
  }
  async function setSettings(patch) {
    try { applySettings(await invoke("set_settings", { patch })); } catch (e) { fail(e); }
  }
  function applySettings(s) {
    const before = JSON.stringify(A.set);
    A.set = s || {};
    CC.applyTheme(A.set.theme);
    if (before === JSON.stringify(A.set)) return;
    drawTop();
    if (A.view === "pets" || A.view === "settings") drawView();
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
  function drawSettings() {
    const s = A.set;
    const seg = (k, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button class="chip${s[k] === v ? " on" : ""}" data-seg="${k}" data-v="${v}">${l}</button>`).join("")}</div>`;
    const chk = (k, l) => `<label class="check"><input type="checkbox" data-chk="${k}"${s[k] ? " checked" : ""}> ${l}</label>`;
    view.innerHTML = `<div class="cols settings">
      <section class="panel"><div class="ph"><span class="pt">${ic("paw")} Pet on the desktop</span></div><div class="pb"><div class="fgrid">
        <label>Pet</label><div>${chk("petVisible", "Show the pet")}</div>
        <label>Size</label>${seg("petSize", [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Extra large"]])}
        <label>Pills</label><div>${seg("pill", [["auto", "For sessions"], ["always", "Always"], ["never", "Never"]])}<div class="note" style="margin-top:.35em">Never leaves a count badge on the pet instead.</div></div>
        <label>Motion</label><div class="chks">${chk("hoverJump", "Jump when the cursor is on the pet")}${chk("look", "Look toward the cursor (v2 pets)")}</div>
        <label>Shadow</label><div>${chk("shadow", "Drop shadow under the pet")}</div>
        <label>Position</label><div><button class="btn sm" data-act="reset-pos">Move to the corner</button></div>
      </div></div></section>
      <section class="panel"><div class="ph"><span class="pt">${ic("gear")} App</span></div><div class="pb"><div class="fgrid">
        <label>Theme</label>${seg("theme", [["auto", "Match system"], ["light", "Cream"], ["dark", "Night"]])}
        <label>Startup</label><div><label class="check"><input type="checkbox" data-auto${A.auto ? " checked" : ""}> Start with ${CC.mac ? "macOS" : "Windows"}, pet only</label></div>
        <label>Pets folder</label><div><div class="path">${esc(A.folder)}</div><button class="btn sm" data-act="folder" style="margin-top:.4em">${ic("folder")} Show folder</button></div>
      </div></div></section>
    </div>`;
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
    };
    if (acts[b.dataset.act]) acts[b.dataset.act]();
  });
  document.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.chk) return setSettings({ [t.dataset.chk]: t.checked });
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
    CC.editor.init({ pets: () => A.pets, activeId: () => A.set.activePet });
    try {
      [A.pets, A.set, A.sessions, A.folder] = await Promise.all([invoke("list_pets"), invoke("get_settings"), invoke("get_sessions"), invoke("pets_folder")]);
      A.auto = await invoke("autostart", {});
    } catch (e) { /* web preview */ }
    CC.applyTheme(A.set.theme);
    drawTop();
    drawView();
    on("nav", (v) => nav(v));
    on("edit-pet", (id) => editPet(id));
    on("pets", loadPets);
    on("settings", applySettings);
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
