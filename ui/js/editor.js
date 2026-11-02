/* The spritesheet editor (CC.editor): a pet's sheet as a grid of 192×208 frames, one row per Codex state.
   - Drag frames to reorder them or move them to another row (the others shift); Shift+drag swaps two frames,
     Ctrl+drag copies. Flip, nudge, copy and paste (also images from other apps), duplicate, clear.
   - Per row: how many frames play ("rowFrames") and each frame's ms (manifest claudeCompanion.timing), with a
     live preview that plays like Codex (three times, then the slow idle) or loops.
   - v1 sheets can gain the two v2 look rows. Sheets that aren't a Codex size are scaled to 1536 wide and saved
     as v1 or v2.
   - Everything is undoable. Frames are ImageData that is never changed in place, so history entries share them.
   Save writes spritesheet.png and pet.json back to the pet folder (lib.rs write_pet; the first save of a pet
   each run keeps a backup). Load after sprite.js; app.js calls init, mount, leave, edit and petsChanged. */
(function () {
  const { $, esc, ic, toast, fail } = CC;
  const SP = CC.sprite, W = SP.CELL_W, H = SP.CELL_H, COLS = SP.COLS;
  const V1 = SP.FORMATS[0], V2 = SP.FORMATS[1];
  const ZOOM = { s: "3.6em", m: "5em", l: "7em" };
  const STATE_KEYS = SP.ROWS.slice(0, 9).map((r) => r.key);
  const MOD = CC.mac ? "⌘" : "Ctrl";
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* storage off */ } return null; };

  let host = null, root = null, active = false, want = null, loading = null, busy = false;
  // the pet being edited; cells[r][c] is ImageData or null (blank)
  const E = { id: null, pet: null, cells: [], rows: 9, rowFrames: [], timing: {}, name: "", description: "", note: "", cleanTx: null };
  let sel = [], focus = null, anchor = null, painted = [], cellEls = [];
  let undo = [], redo = [], cur = null, nudgeTx = null, clip = [], drag = null, ghost = null;
  let zoom = ZOOM[ls("cc.ed.zoom")] ? ls("cc.ed.zoom") : "m";
  const PV = { loop: true, playing: true, list: [], loopStart: 0, i: 0, timer: null, row: -1, hover: null };
  const savedOnce = new Set();

  const key = (r, c) => r + ":" + c;
  const unkey = (k) => k.split(":").map(Number);
  const isLook = (r) => r >= 9;
  const fmtNow = () => (E.rows === 11 ? V2 : V1);
  const required = (r) => fmtNow().required[r] || COLS;
  const rowState = (r) => SP.ROWS[r].key;
  const petLike = () => ({ fmt: fmtNow(), rowFrames: E.rowFrames, timing: E.timing });
  const msOf = (r, c) => {
    const st = rowState(r), t = E.timing[st];
    return t && Number.isFinite(t[c]) && t[c] > 0 ? t[c] : SP.defaultMs(st, c, E.rowFrames[r]);
  };
  const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " s";
  const cellEl = (r, c) => (cellEls[r] ? cellEls[r][c] : null);
  const isDirty = () => !!E.pet && (undo[undo.length - 1] || null) !== E.cleanTx;

  /* ───────── pixels ───────── */
  const emptyCache = new WeakMap();
  function isEmpty(img) {
    if (!img) return true;
    let v = emptyCache.get(img);
    if (v == null) {
      v = true;
      const d = img.data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) { v = false; break; }
      emptyCache.set(img, v);
    }
    return v;
  }
  function paint(cv, img) {
    const x = cv.getContext("2d");
    if (img) x.putImageData(img, 0, 0); else x.clearRect(0, 0, W, H);
  }
  function scratch(img) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    paint(cv, img);
    return cv;
  }
  const px = (img) => new Uint32Array(img.data.buffer, img.data.byteOffset, W * H);
  function flipImg(img, horiz) {
    if (!img) return null;
    const out = new ImageData(W, H), a = px(img), b = px(out);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b[y * W + x] = horiz ? a[y * W + (W - 1 - x)] : a[(H - 1 - y) * W + x];
    return out;
  }
  function shiftImg(img, dx, dy) {
    if (!img) return null;
    const out = new ImageData(W, H), a = px(img), b = px(out);
    for (let y = 0; y < H; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < W; x++) { const sx = x - dx; if (sx >= 0 && sx < W) b[y * W + x] = a[sy * W + sx]; }
    }
    return out;
  }
  function samePixels(a, b) {
    if (!a || !b) return a === b;
    const x = px(a), y = px(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  /* Any image as one frame: 192×208 as is, otherwise scaled to fit (whole steps when enlarging), centred. */
  function fitImg(bmp) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const x = cv.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingEnabled = false;
    if (bmp.width === W && bmp.height === H) x.drawImage(bmp, 0, 0);
    else {
      let s = Math.min(W / bmp.width, H / bmp.height);
      if (s >= 1) s = Math.floor(s);
      const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      x.drawImage(bmp, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
    }
    const d = x.getImageData(0, 0, W, H);
    return isEmpty(d) ? null : d;
  }
  const loadImage = (url) => new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Couldn't read the spritesheet"));
    i.src = url;
  });

  /* ───────── history ───────── */
  const metaSnap = () => JSON.parse(JSON.stringify({ rows: E.rows, rowFrames: E.rowFrames, timing: E.timing, name: E.name, description: E.description }));
  function setMeta(m) {
    E.rowFrames = m.rowFrames.slice();
    E.timing = JSON.parse(JSON.stringify(m.timing));
    E.name = m.name;
    E.description = m.description;
  }
  function setCell(r, c, img) {
    const prev = E.cells[r][c];
    if (prev === img) return;
    if (cur) {
      const k = key(r, c);
      if (cur.cells.has(k)) cur.cells.get(k)[1] = img; else cur.cells.set(k, [prev, img]);
    }
    E.cells[r][c] = img;
  }
  function setRows(n) {
    while (E.cells.length < n) E.cells.push(new Array(COLS).fill(null));
    for (let r = n; r < E.cells.length; r++) for (let c = 0; c < COLS; c++) setCell(r, c, null);
    E.cells.length = n;
    while (E.rowFrames.length < n) E.rowFrames.push(COLS);
    E.rowFrames.length = n;
    E.rows = n;
  }
  /* Runs one undoable change. */
  function edit(label, fn) {
    const tx = { label, cells: new Map(), m0: metaSnap(), m1: null };
    cur = tx;
    try { fn(); } finally { cur = null; }
    tx.m1 = metaSnap();
    for (const [k, p] of tx.cells) if (p[0] === p[1]) tx.cells.delete(k);
    if (!tx.cells.size && JSON.stringify(tx.m0) === JSON.stringify(tx.m1)) return null;
    undo.push(tx);
    if (undo.length > 300) undo.shift();
    redo.length = 0;
    changed(tx.m0.rows !== tx.m1.rows);
    return tx;
  }
  function step(back) {
    const from = back ? undo : redo, to = back ? redo : undo;
    const tx = from.pop();
    if (!tx) return;
    to.push(tx);
    const m = back ? tx.m0 : tx.m1, d = back ? 0 : 1, rows0 = E.rows;
    if (m.rows > E.rows) setRows(m.rows);
    const touched = [];
    for (const [k, p] of tx.cells) {
      const [r, c] = unkey(k);
      if (E.cells[r]) { E.cells[r][c] = p[d]; touched.push(k); }
    }
    if (m.rows < E.rows) setRows(m.rows);
    setMeta(m);
    if (touched.length) {
      sel = touched.filter((k) => unkey(k)[0] < E.rows);
      if (sel.length) { const [r, c] = unkey(sel[0]); focus = { r, c }; anchor = { r, c }; }
    }
    changed(rows0 !== E.rows);
    toast((back ? "Undid " : "Redid ") + tx.label.toLowerCase(), { ms: 1600 });
  }

  /* ───────── frame operations ───────── */
  const items = () => sel.map(unkey).filter(([r]) => r < E.rows).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([r, c]) => ({ r, c }));
  const rowItems = () => (focus ? items().filter((i) => i.r === focus.r) : []);

  /* Moves (or copies) frames to row tr, inserted before column tc; frames after it shift right, and a moved
     frame's row closes up behind it. A row plays one more frame per frame inserted into its played part. */
  function insertFrames(list, tr, tc, copy) {
    let placed = null, lost = 0;
    const tx = edit(copy ? "Copy frames" : "Move frames", () => {
      const rows = new Map();
      const get = (r) => { if (!rows.has(r)) rows.set(r, E.cells[r].slice()); return rows.get(r); };
      const imgs = list.map(({ r, c }) => E.cells[r][c]);
      const n = E.rowFrames.slice();
      let t = tc;
      if (!copy) {
        const byRow = new Map();
        for (const { r, c } of list) byRow.set(r, [...(byRow.get(r) || []), c]);
        for (const [r, cols] of byRow) {
          const arr = get(r);
          for (const c of cols.sort((a, b) => b - a)) {
            arr.splice(c, 1);
            arr.push(null);
            if (c < n[r]) n[r]--;
            if (r === tr && c < tc) t--;
          }
        }
      }
      const arr = get(tr);
      arr.splice(t, 0, ...imgs);
      lost = arr.slice(COLS).filter((img) => !isEmpty(img)).length;
      arr.length = COLS;
      n[tr] = Math.max(n[tr], t) + imgs.length;
      for (const [r, a] of rows) a.forEach((img, c) => setCell(r, c, img));
      n.forEach((v, r) => { E.rowFrames[r] = isLook(r) ? COLS : Math.max(1, Math.min(COLS, v)); });
      placed = { r: tr, from: t, to: Math.min(COLS, t + imgs.length) };
    });
    if (tx && placed) {
      sel = [];
      for (let c = placed.from; c < placed.to; c++) sel.push(key(placed.r, c));
      if (sel.length) { focus = { r: placed.r, c: placed.from }; anchor = { ...focus }; }
      refreshSel(); drawSide(); pvRebuild(true);
    }
    if (lost) toast(`${lost === 1 ? "A frame" : lost + " frames"} fell off the end of ${SP.ROWS[tr].label}. ${MOD}+Z brings ${lost === 1 ? "it" : "them"} back.`, { ms: 6000 });
  }
  function swap(a, b) {
    edit("Swap frames", () => {
      const x = E.cells[a.r][a.c], y = E.cells[b.r][b.c];
      setCell(a.r, a.c, y);
      setCell(b.r, b.c, x);
    });
    sel = [key(b.r, b.c)];
    focus = { r: b.r, c: b.c };
    anchor = { ...focus };
    refreshSel(); drawSide();
  }
  function shiftFrames(dir) {
    const its = rowItems();
    if (!its.length) return;
    const cols = its.map((i) => i.c), lo = Math.min(...cols), hi = Math.max(...cols);
    if ((dir < 0 && lo === 0) || (dir > 0 && hi === COLS - 1)) return;
    insertFrames(its, focus.r, dir < 0 ? lo - 1 : hi + 2, false);
  }
  function duplicate() {
    const its = rowItems();
    if (!its.length) return;
    insertFrames(its, focus.r, Math.max(...its.map((i) => i.c)) + 1, true);
  }
  function clearSel() { edit("Clear frames", () => items().forEach(({ r, c }) => setCell(r, c, null))); }
  function flipSel(horiz) { edit("Flip frames", () => items().forEach(({ r, c }) => setCell(r, c, flipImg(E.cells[r][c], horiz)))); }
  /* Nudges in a row of presses are one history step drawn from the original, so nothing is lost at the edges
     until you do something else. */
  function nudge(dx, dy) {
    const its = items(), sig = sel.join(",");
    const last = undo[undo.length - 1];
    if (nudgeTx && last === nudgeTx.tx && last !== E.cleanTx && nudgeTx.sig === sig) {
      nudgeTx.dx += dx; nudgeTx.dy += dy;
      for (const { r, c } of its) {
        const p = nudgeTx.tx.cells.get(key(r, c));
        if (!p) continue;
        p[1] = shiftImg(p[0], nudgeTx.dx, nudgeTx.dy);
        E.cells[r][c] = p[1];
      }
      redo.length = 0;
      changed(false);
      return;
    }
    const tx = edit("Nudge", () => its.forEach(({ r, c }) => setCell(r, c, shiftImg(E.cells[r][c], dx, dy))));
    nudgeTx = tx ? { tx, sig, dx, dy } : null;
  }
  async function copySel() {
    const its = items();
    if (!its.length) return;
    clip = its.map(({ r, c }) => E.cells[r][c]);
    toast(its.length === 1 ? "Copied the frame" : `Copied ${its.length} frames`, { ms: 1600 });
    try {
      if (!clip[0] || !navigator.clipboard || !window.ClipboardItem) return;
      const blob = await new Promise((res) => scratch(clip[0]).toBlob(res, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (e) { /* the app clipboard still has it */ }
  }
  function placeImages(label, imgs) {
    if (!focus || !imgs.length) return;
    const { r, c } = focus;
    edit(label, () => imgs.forEach((img, i) => { if (c + i < COLS) setCell(r, c + i, img); }));
    sel = [];
    for (let i = 0; i < imgs.length && c + i < COLS; i++) sel.push(key(r, c + i));
    refreshSel(); drawSide();
  }
  function pasteClip() {
    if (!clip.length) return toast(`Copy a frame first, or press ${MOD}+V with an image from another app`, { ms: 3200 });
    placeImages("Paste frames", clip);
  }
  async function pasteFiles(files) {
    const imgs = [];
    for (const f of files) {
      try { const b = await createImageBitmap(f); imgs.push(fitImg(b)); b.close && b.close(); } catch (e) { toast(`Couldn't read ${f.name || "that image"}`, { bad: true }); }
    }
    if (!imgs.length) return;
    // our own copy coming back through the system clipboard: paste every copied frame, not just the first
    if (imgs.length === 1 && clip.length > 1 && samePixels(imgs[0], clip[0])) return pasteClip();
    placeImages("Paste image", imgs);
  }

  /* ───────── row settings ───────── */
  function setFrames(r, n) { edit("Frame count", () => { E.rowFrames[r] = Math.max(1, Math.min(COLS, n)); }); }
  function setTimes(r, fn, label) {
    const st = rowState(r), n = E.rowFrames[r];
    edit(label || "Timing", () => {
      const arr = Array.from({ length: n }, (_, c) => msOf(r, c));
      fn(arr);
      for (let c = 0; c < n; c++) arr[c] = Math.max(16, Math.min(60000, Math.round(arr[c])));
      if (arr.every((v, c) => v === SP.defaultMs(st, c, n))) delete E.timing[st]; else E.timing[st] = arr;
    });
  }
  function resetTimes(r) { edit("Reset timing", () => { delete E.timing[rowState(r)]; }); }

  /* ───────── load, save ───────── */
  async function open(target) {
    const info = typeof target === "string" ? host.pets().find((p) => p.id === target) : target;
    if (!info) return toast("That pet isn't in the pets folder anymore", { bad: true });
    if (E.pet && info.id === E.id && !loading) return;
    if (isDirty() && !(await confirmLeave())) { syncPicker(); return; }
    const token = (loading = {});
    render();
    let img;
    try { img = await loadImage(SP.model(info).url); } catch (e) { if (loading === token) loading = null; render(); return fail(e); }
    if (loading !== token) return;
    loading = null;
    const pet = SP.model(info);
    // sheets that aren't 1536 wide are scaled to it (pixel art stays crisp), then cut into 192×208 cells
    const scale = img.naturalWidth === V1.width ? 1 : V1.width / img.naturalWidth;
    const sw = V1.width, sh = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement("canvas");
    cv.width = sw; cv.height = sh;
    const x = cv.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingEnabled = false;
    x.drawImage(img, 0, 0, sw, sh);
    const found = Math.max(1, Math.ceil(sh / H - 0.02));
    const rows = pet.fmt ? pet.fmt.rows : found > 9 ? 11 : 9;
    E.id = info.id; E.pet = pet; E.rows = rows; E.cells = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const d = r < found ? x.getImageData(c * W, r * H, W, H) : null;
        row.push(d && !isEmpty(d) ? d : null);
      }
      E.cells.push(row);
    }
    const req = (rows === 11 ? V2 : V1).required;
    E.rowFrames = req.map((d, r) => {
      const v = pet.rowFrames && pet.rowFrames[r];
      return isLook(r) ? COLS : Number.isFinite(v) && v > 0 ? Math.min(COLS, Math.round(v)) : d;
    });
    E.timing = {};
    for (const st of STATE_KEYS) {
      const t = pet.timing && pet.timing[st];
      if (Array.isArray(t) && t.every((v) => Number.isFinite(v) && v > 0)) E.timing[st] = t.slice(0, COLS);
    }
    E.name = pet.name; E.description = pet.description;
    E.note = pet.valid ? "" :
      `This sheet is ${info.width}×${info.height}${scale !== 1 ? ", shown scaled to 1536 wide" : ""}. ` +
      `Codex needs 1536×1872 (v1) or 1536×2288 (v2); saving writes a ${rows === 11 ? "v2" : "v1"} sheet from these frames` +
      (found > 11 ? " and leaves out the rows past 11." : ".");
    undo = []; redo = []; E.cleanTx = null; nudgeTx = null;
    sel = [key(0, 0)]; focus = { r: 0, c: 0 }; anchor = { r: 0, c: 0 };
    PV.i = 0; PV.row = -1;
    render();
  }
  async function confirmLeave() {
    const v = await CC.ask("Unsaved changes", `Save your changes to ${E.name} first?`, [
      { label: "Save", value: "save", cls: "primary" }, { label: "Discard", value: "discard" }, { label: "Cancel", value: null, cls: "ghost" },
    ]);
    if (v === "save") { await save(false); return !isDirty(); }
    return v === "discard";
  }
  function manifestOut(copy) {
    const m = JSON.parse(JSON.stringify(E.pet.manifest || {}));
    if (copy) { delete m.id; delete m.spritesheetPath; }
    m.displayName = copy ? E.name + " copy" : E.name;
    m.description = E.description;
    if ("spriteVersionNumber" in m) m.spriteVersionNumber = E.rows === 11 ? 2 : 1;
    const req = fmtNow().required;
    if (E.rowFrames.some((n, r) => n !== req[r])) m.rowFrames = E.rowFrames.slice(); else delete m.rowFrames;
    const timing = {};
    for (const st of STATE_KEYS) {
      if (!E.timing[st]) continue;
      const r = SP.stateRow(st), n = E.rowFrames[r];
      const eff = Array.from({ length: n }, (_, c) => msOf(r, c));
      if (eff.some((v, c) => v !== SP.defaultMs(st, c, n))) timing[st] = eff;
    }
    const cc = m.claudeCompanion && typeof m.claudeCompanion === "object" ? m.claudeCompanion : {};
    if (Object.keys(timing).length) cc.timing = timing; else delete cc.timing;
    if (Object.keys(cc).length) m.claudeCompanion = cc; else delete m.claudeCompanion;
    return m;
  }
  async function save(copy) {
    if (!E.pet || busy) return;
    if (!CC.live) return toast("Saving needs the Claude Companion app", { bad: true });
    busy = true; refreshBar();
    try {
      const f = fmtNow();
      const cv = document.createElement("canvas");
      cv.width = f.width; cv.height = f.height;
      const x = cv.getContext("2d");
      for (let r = 0; r < E.rows; r++) for (let c = 0; c < COLS; c++) if (E.cells[r][c]) x.putImageData(E.cells[r][c], c * W, r * H);
      const blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't encode the PNG"))), "image/png"));
      const bytes = await blob.arrayBuffer();
      const m = manifestOut(copy);
      if (copy) {
        const info = await CC.writePet({ mode: "create", name: m.displayName, manifest: m, ext: "png" }, bytes);
        toast(`Saved a copy as ${info.displayName}`, { action: "Edit the copy", onAction: () => open(info) });
      } else {
        const info = await CC.writePet({ mode: "save", id: E.id, manifest: m, backup: true }, bytes);
        const first = !savedOnce.has(E.id);
        savedOnce.add(E.id);
        E.pet = SP.model(info); E.note = ""; E.cleanTx = undo[undo.length - 1] || null;
        toast(first ? `Saved ${E.name}. The original is backed up in the pet's .companion-backup folder.` : `Saved ${E.name}`, { ms: first ? 6000 : 2400 });
      }
    } catch (e) { fail(e); }
    busy = false;
    refreshBar();
  }

  /* ───────── rendering ───────── */
  const btn = (act, icon, title, extra = "") => `<button class="btn sm icon" data-ed="${act}" title="${esc(title)}" aria-label="${esc(title)}"${extra}>${ic(icon)}</button>`;
  function render() {
    if (!active || !root) return;
    const pets = host.pets();
    if (!E.pet) {
      root.innerHTML = `<section class="panel"><div class="ph"><span class="pt">${ic("grid")} Spritesheet editor</span></div><div class="pb">` +
        (pets.length || loading
          ? `<div class="m-empty">${ic("grid", "big")}<b>${loading ? "Opening the sheet…" : "Pick a pet to edit"}</b>${loading ? "" : `<div class="actions">${pets.map((p) => `<button class="btn" data-ed="open" data-id="${esc(p.id)}">${esc(p.displayName || p.id)}</button>`).join("")}</div>`}</div>`
          : `<div class="m-empty">${ic("pets", "big")}<b>No pets yet</b><span>Add a Codex pet on the Pets view, then edit its frames here.</span><div class="actions"><button class="btn primary" data-view="pets">${ic("pets")} Go to pets</button></div></div>`) +
        `</div></section>`;
      return;
    }
    const f = fmtNow();
    root.innerHTML = `<div class="ed" style="--cw:${ZOOM[zoom]}">
      <section class="panel sheet">
        <div class="ph"><span class="pt">${ic("grid")} Spritesheet</span><span class="cnt">v${E.rows === 11 ? 2 : 1} · ${f.width}×${f.height}</span><span class="sp"></span>
          <select id="edPick" aria-label="Pet to edit" data-nodrag>${pickerHtml()}</select></div>
        <div class="tbar">
          ${btn("undo", "undo", `Undo (${MOD}+Z)`)}${btn("redo", "redo", `Redo (${MOD}+Y)`)}<span class="sep"></span>
          <div class="seg" role="group" aria-label="Frame size">${Object.keys(ZOOM).map((z) => `<button class="chip${zoom === z ? " on" : ""}" data-zoom="${z}" title="Frame size">${z.toUpperCase()}</button>`).join("")}</div>
          <span class="sep"></span>
          ${E.rows === 9 ? `<button class="btn sm" data-ed="add-look" title="Add rows 9–10 so the pet can look toward the cursor (v2)">${ic("eye")} Add look rows</button>` : `<button class="btn sm ghost" data-ed="drop-look" title="Remove rows 9–10 and save as v1">Remove look rows</button>`}
          <span class="sp"></span><span class="tag" id="edState"></span>
          <button class="btn sm" data-ed="save-copy" title="Save as a new pet (${MOD}+Shift+S)">${ic("copy")} Save as copy</button>
          <button class="btn sm primary" data-ed="save" title="Save (${MOD}+S)">${ic("save")} Save</button>
        </div>
        <div class="meta"><input id="edName" value="${esc(E.name)}" placeholder="Name" aria-label="Name" spellcheck="false"><input id="edDesc" value="${esc(E.description)}" placeholder="Description" aria-label="Description"></div>
        ${E.note ? `<div class="banner">${ic("warn")}<span>${esc(E.note)}</span></div>` : ""}
        <div class="pb" id="edRows">${rowsHtml()}</div>
      </section>
      <aside class="side">
        <section class="panel">
          <div class="ph"><span class="pt">${ic("film")} Preview</span><span class="cnt" id="pvName"></span></div>
          <div class="pb">
            <div class="stage-well checker pv-stage" id="pvStage"><canvas id="pvCanvas" width="${W}" height="${H}"></canvas><span class="fr" id="pvFr"></span></div>
            <div class="pv-bar" style="margin-top:.6em">
              ${btn("pv-back", "back", "Previous frame (,)")}<span id="pvPlay">${btn("pv-play", PV.playing ? "pause" : "play", "Play or pause (Space)")}</span>${btn("pv-step", "step", "Next frame (.)")}
              <span style="flex:1"></span>
              <div class="seg" role="group" aria-label="Playback"><button class="chip${PV.loop ? " on" : ""}" data-ed="pv-loop" title="Loop this row">Loop</button><button class="chip${PV.loop ? "" : " on"}" data-ed="pv-codex" title="Three times, then the slow idle">Like Codex</button></div>
            </div>
          </div>
        </section>
        <section class="panel" id="edFrame"></section>
        <section class="panel" id="edRow"></section>
        <section class="panel">
          <div class="ph"><span class="pt">${ic("bolt")} Keys</span></div>
          <div class="pb"><div class="kbdhelp">
            <kbd>Drag</kbd><span>Move frames; the others shift</span>
            <kbd>Shift+drag</kbd><span>Swap two frames</span>
            <kbd>${MOD}+drag</kbd><span>Copy frames</span>
            <kbd>Alt+← →</kbd><span>Move the selection along its row</span>
            <kbd>${MOD}+arrows</kbd><span>Nudge 1 px (add Shift for 8)</span>
            <kbd>H</kbd><span>Flip horizontally; <kbd>V</kbd> vertically</span>
            <kbd>${MOD}+C V D</kbd><span>Copy, paste (images too), duplicate</span>
            <kbd>Delete</kbd><span>Clear</span>
            <kbd>Space</kbd><span>Play or pause; <kbd>,</kbd> <kbd>.</kbd> step</span>
            <kbd>${MOD}+Z Y</kbd><span>Undo, redo</span>
          </div></div>
        </section>
      </aside>
    </div>`;
    cellEls = [];
    painted = [];
    root.querySelectorAll(".ed .cell").forEach((el) => {
      const r = +el.dataset.r, c = +el.dataset.c;
      (cellEls[r] = cellEls[r] || [])[c] = el;
    });
    for (let r = 0; r < E.rows; r++) painted.push(new Array(COLS).fill(undefined));
    syncCells(); refreshRows(); refreshSel(); drawSide(); refreshBar(); pvRebuild(true);
  }
  function pickerHtml() {
    const pets = host.pets();
    const list = pets.some((p) => p.id === E.id) ? pets : [{ id: E.id, displayName: E.name }, ...pets];
    return list.map((p) => `<option value="${esc(p.id)}"${p.id === E.id ? " selected" : ""}>${esc(p.displayName || p.id)}</option>`).join("");
  }
  function syncPicker() { const s = $("#edPick"); if (s) s.innerHTML = pickerHtml(); }
  function rowsHtml() {
    let h = "";
    for (let r = 0; r < E.rows; r++) {
      const R = SP.ROWS[r];
      h += `<div class="srow" data-r="${r}"><div class="rh" data-row="${r}" title="${esc(R.note)}"><span class="rl">${esc(R.label)}</span><span class="rm"></span></div>`;
      for (let c = 0; c < COLS; c++) h += `<div class="cell checker" data-r="${r}" data-c="${c}"><canvas width="${W}" height="${H}"></canvas><span class="n">${c + 1}</span><span class="ms"></span></div>`;
      h += "</div>";
    }
    return h;
  }
  function syncCells() {
    for (let r = 0; r < E.rows; r++) for (let c = 0; c < COLS; c++) {
      const el = cellEl(r, c);
      if (!el || painted[r][c] === E.cells[r][c]) continue;
      paint(el.firstElementChild, E.cells[r][c]);
      painted[r][c] = E.cells[r][c];
    }
  }
  function refreshRows() {
    for (let r = 0; r < E.rows; r++) {
      const look = isLook(r), n = look ? COLS : E.rowFrames[r];
      let total = 0;
      for (let c = 0; c < COLS; c++) {
        const el = cellEl(r, c);
        if (!el) continue;
        const used = c < n, img = E.cells[r][c];
        el.classList.toggle("unused", !used);
        el.classList.toggle("missing", used && isEmpty(img));
        const ms = !look && used ? msOf(r, c) : 0;
        total += ms;
        el.lastElementChild.textContent = ms ? String(ms) : "";
        el.title = `${SP.ROWS[r].label} ${c + 1}${used ? (ms ? ` · ${ms} ms` : "") : " · not played"}${used && isEmpty(img) ? " · empty" : ""}`;
      }
      const rm = root.querySelector(`.srow[data-r="${r}"] .rm`);
      if (!rm) continue;
      const req = required(r);
      rm.innerHTML = look ? `Directions ${r === 9 ? "1–8" : "9–16"}` :
        `<b>${n}</b> frames · ${secs(total)}${n !== req ? ` · <span class="warn">Codex plays ${req}</span>` : ""}`;
    }
  }
  function refreshSel() {
    const set = new Set(sel), fk = focus ? key(focus.r, focus.c) : "";
    for (let r = 0; r < E.rows; r++) for (let c = 0; c < COLS; c++) {
      const el = cellEl(r, c);
      if (!el) continue;
      const k = key(r, c);
      el.classList.toggle("sel", k === fk);
      el.classList.toggle("multi", k !== fk && set.has(k));
    }
    root.querySelectorAll(".srow").forEach((el) => el.classList.toggle("cur", !!focus && +el.dataset.r === focus.r));
  }
  function refreshBar() {
    if (!root) return;
    const u = root.querySelector('[data-ed="undo"]'), r = root.querySelector('[data-ed="redo"]');
    if (u) u.disabled = !undo.length;
    if (r) r.disabled = !redo.length;
    const st = $("#edState");
    if (st) {
      const dirty = isDirty();
      st.className = "tag" + (busy ? "" : dirty ? " warn" : E.pet && !E.pet.valid ? " bad" : " ok");
      st.textContent = busy ? "Saving" : dirty ? "Unsaved" : E.pet && !E.pet.valid ? "Not a Codex size" : "Saved";
    }
    const s = root.querySelector('[data-ed="save"]');
    if (s) s.disabled = busy || !(isDirty() || (E.pet && !E.pet.valid));
  }
  function drawSide() {
    const fr = $("#edFrame"), rw = $("#edRow");
    if (!fr || !rw || !focus) return;
    const { r, c } = focus, R = SP.ROWS[r], n = sel.length;
    fr.innerHTML = `<div class="ph"><span class="pt">${ic("image")} Frame</span><span class="cnt">${esc(R.label)} ${c + 1}${n > 1 ? ` · ${n} selected` : ""}</span></div>
      <div class="pb"><div class="ftools">
        <div class="stage-well checker fv-stage"><canvas id="fvCanvas" width="${W}" height="${H}"></canvas></div>
        <div class="fcol">
          <div class="actions">${btn("flip-h", "flip", "Flip horizontally (H)")}${btn("flip-v", "flipv", "Flip vertically (V)")}${btn("copy", "copy", `Copy (${MOD}+C)`)}${btn("paste", "paste", `Paste (${MOD}+V)`)}${btn("dup", "plus", `Duplicate after (${MOD}+D)`)}${btn("clear", "trash", "Clear (Delete)")}</div>
          <div class="actions"><div class="nudge" role="group" aria-label="Nudge 1 px">
            <button class="btn sm u" data-ed="nudge" data-dx="0" data-dy="-1" title="Nudge up" aria-label="Nudge up">${ic("up")}</button>
            <button class="btn sm l" data-ed="nudge" data-dx="-1" data-dy="0" title="Nudge left" aria-label="Nudge left">${ic("left")}</button>
            <button class="btn sm d" data-ed="nudge" data-dx="0" data-dy="1" title="Nudge down" aria-label="Nudge down">${ic("down")}</button>
            <button class="btn sm r" data-ed="nudge" data-dx="1" data-dy="0" title="Nudge right" aria-label="Nudge right">${ic("right")}</button>
          </div><span class="note">Nudge 1 px;<br>Shift for 8</span></div>
          <button class="btn sm" data-ed="replace">${ic("image")} Replace from image…</button>
        </div>
      </div></div>`;
    paint($("#fvCanvas"), E.cells[r][c]);

    const look = isLook(r);
    let body;
    if (look) {
      body = `<p class="note" style="margin:0">While idle, running or waving, a v2 pet looks toward the cursor with these frames: direction 1 is straight up, then clockwise in 22.5° steps. Hover the preview to try them.</p>`;
    } else {
      const st = rowState(r), nf = E.rowFrames[r], req = required(r);
      const times = Array.from({ length: nf }, (_, i) => msOf(r, i));
      const same = times.every((v) => v === times[0]);
      body = `<div class="fgrid">
          <label>Frames</label><span class="stepper"><button class="btn sm icon" data-ed="n-dec" title="Play one frame fewer" aria-label="Play one frame fewer"${nf <= 1 ? " disabled" : ""}>${ic("minus")}</button><b>${nf}</b><button class="btn sm icon" data-ed="n-inc" title="Play one frame more" aria-label="Play one frame more"${nf >= COLS ? " disabled" : ""}>${ic("plus")}</button>${nf !== req ? `<span class="tag warn">Codex plays ${req}</span>` : ""}</span>
          <label for="edAll">Every frame</label><span><input type="number" id="edAll" min="16" max="60000" step="10" value="${same ? times[0] : ""}" placeholder="Mixed"> ms</span>
        </div>
        <div class="timing">${times.map((v, i) => `<label for="edMs${i}"${i === c ? ' class="cur"' : ""}>Frame ${i + 1}${i === nf - 1 && nf > 1 ? " (last)" : ""}</label><span><input type="number" id="edMs${i}" data-ms="${i}" min="16" max="60000" step="10" value="${v}"${i === c ? ' class="cur"' : ""}> ms</span>`).join("")}</div>
        <div class="rowtools"><button class="btn sm" data-ed="t-fast">Faster</button><button class="btn sm" data-ed="t-slow">Slower</button><button class="btn sm ghost" data-ed="t-reset"${E.timing[st] ? "" : " disabled"}>Reset to Codex</button></div>
        <p class="note" style="margin:.7em 0 0">Codex plays its own timing and the standard frame count; these apply on the Claude Companion pet${st === "idle" ? ". Idle runs at one sixth speed, already counted here" : ""}.</p>`;
    }
    rw.innerHTML = `<div class="ph"><span class="pt">${ic("timer")} Row</span><span class="cnt">${esc(R.label)}</span></div><div class="pb">${body}</div>`;
  }
  function changed(structural) {
    if (!active) return;
    if (focus && focus.r >= E.rows) { focus = { r: 0, c: 0 }; anchor = { r: 0, c: 0 }; sel = [key(0, 0)]; }
    if (structural) { render(); return; }
    syncCells(); refreshRows(); refreshSel(); drawSide(); refreshBar(); pvRebuild(true);
    const n = $("#edName"), d = $("#edDesc");
    if (n && document.activeElement !== n) n.value = E.name;
    if (d && document.activeElement !== d) d.value = E.description;
  }

  /* ───────── selection ───────── */
  function select(r, c, mode) {
    const k = key(r, c), rowBefore = focus ? focus.r : -1;
    focus = { r, c };
    if (mode === "toggle") {
      const i = sel.indexOf(k);
      if (i >= 0 && sel.length > 1) {
        sel.splice(i, 1);
        const [fr, fc] = unkey(sel[sel.length - 1]);
        focus = { r: fr, c: fc };
      } else if (i < 0) sel.push(k);
      anchor = { ...focus };
    } else if (mode === "range" && anchor) {
      const a = anchor.r * COLS + anchor.c, b = r * COLS + c;
      sel = [];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.push(key(Math.floor(i / COLS), i % COLS));
    } else {
      sel = [k];
      anchor = { r, c };
    }
    refreshSel(); drawSide();
    if (rowBefore !== focus.r) pvRebuild(false);
    else if (!PV.playing) {
      const i = PV.list.findIndex((f) => f.row === focus.r && f.col === focus.c);
      if (i >= 0) { PV.i = i; pvShow(); }
    }
  }
  function selectRow(r) {
    const n = isLook(r) ? COLS : E.rowFrames[r];
    focus = { r, c: 0 };
    anchor = { r, c: 0 };
    sel = [];
    for (let c = 0; c < n; c++) sel.push(key(r, c));
    refreshSel(); drawSide(); pvRebuild(false);
  }
  function moveFocus(dr, dc, extend) {
    if (!focus) return;
    const r = Math.max(0, Math.min(E.rows - 1, focus.r + dr)), c = Math.max(0, Math.min(COLS - 1, focus.c + dc));
    select(r, c, extend ? "range" : "only");
    const el = cellEl(r, c);
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /* ───────── preview ───────── */
  function pvRebuild(keep) {
    clearTimeout(PV.timer);
    PV.timer = null;
    if (!E.pet || !focus) return;
    const r = focus.r;
    if (r !== PV.row) { keep = false; PV.hover = null; }
    PV.row = r;
    if (isLook(r)) {
      PV.list = [];
      for (let o = 0; o < 16; o++) PV.list.push({ row: 9 + (o >> 3), col: o & 7, ms: 140 });
      PV.loopStart = 0;
    } else {
      const t = SP.timeline(rowState(r), petLike(), { loop: PV.loop });
      PV.list = t.frames;
      PV.loopStart = t.loopStart;
    }
    if (!keep || PV.i >= PV.list.length) PV.i = 0;
    const nm = $("#pvName");
    if (nm) nm.textContent = SP.ROWS[r].label;
    pvShow();
    pvRun();
  }
  function pvShow() {
    const cv = $("#pvCanvas");
    if (!cv) return;
    const f = PV.hover || PV.list[PV.i];
    if (!f || !E.cells[f.row]) { paint(cv, null); return; }
    paint(cv, E.cells[f.row][f.col]);
    const fr = $("#pvFr");
    if (fr) fr.textContent = PV.hover ? `Looking ${f.col + 1 + (f.row - 9) * 8} of 16` : `${SP.ROWS[f.row].label} ${f.col + 1}${isLook(f.row) ? "" : ` · ${f.ms} ms`}`;
    const was = root.querySelector(".cell.playing");
    if (was) was.classList.remove("playing");
    const el = cellEl(f.row, f.col);
    if (el) el.classList.add("playing");
  }
  function pvRun() {
    clearTimeout(PV.timer);
    PV.timer = null;
    if (!active || !PV.playing || PV.hover || PV.list.length < 2) return;
    PV.timer = setTimeout(() => {
      let n = PV.i + 1;
      if (n >= PV.list.length) {
        if (PV.loopStart == null) { PV.playing = false; pvButton(); return; }
        n = PV.loopStart;
      }
      PV.i = n;
      pvShow();
      pvRun();
    }, PV.list[PV.i].ms);
  }
  function setLoop(on) {
    PV.loop = on;
    PV.playing = true;
    root.querySelectorAll('[data-ed="pv-loop"], [data-ed="pv-codex"]').forEach((b) => b.classList.toggle("on", (b.dataset.ed === "pv-loop") === on));
    pvButton();
    pvRebuild(false);
  }
  function pvButton() { const b = $("#pvPlay"); if (b) b.innerHTML = btn("pv-play", PV.playing ? "pause" : "play", "Play or pause (Space)"); }
  function pvToggle() { PV.playing = !PV.playing; pvButton(); pvRun(); }
  function pvStep(d) {
    if (!PV.list.length) return;
    PV.playing = false;
    PV.i = (PV.i + d + PV.list.length) % PV.list.length;
    pvButton(); pvShow(); clearTimeout(PV.timer);
  }

  /* ───────── dragging frames ───────── */
  function clearAim() { root.querySelectorAll(".drop-before, .drop-after, .drop-swap, .drop-copy").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-swap", "drop-copy")); }
  function startDrag() {
    drag.on = true;
    drag.items = sel.includes(drag.k) ? items() : [{ r: drag.r, c: drag.c }];
    ghost = document.createElement("div");
    ghost.className = "fghost checker";
    const cv = scratch(E.cells[drag.r][drag.c]);
    ghost.appendChild(cv);
    ghost.insertAdjacentHTML("beforeend", `<span class="gl"></span>`);
    document.body.appendChild(ghost);
    document.body.style.cursor = "grabbing";
  }
  function aim(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest(".ed .cell");
    clearAim();
    const lbl = ghost.lastElementChild, n = drag.items.length;
    if (!cell) { drag.target = null; lbl.textContent = ""; return; }
    const r = +cell.dataset.r, c = +cell.dataset.c;
    const mode = e.shiftKey ? "swap" : e.ctrlKey || e.metaKey || e.altKey ? "copy" : "move";
    if (mode === "swap") {
      cell.classList.add("drop-swap");
      drag.target = { mode, r, c };
      lbl.textContent = "Swap";
      return;
    }
    const rect = cell.getBoundingClientRect(), after = e.clientX > rect.left + rect.width / 2;
    cell.classList.add(after ? "drop-after" : "drop-before");
    if (mode === "copy") cell.classList.add("drop-copy");
    drag.target = { mode, r, c: c + (after ? 1 : 0) };
    lbl.textContent = `${mode === "copy" ? "Copy" : "Move"}${n > 1 ? ` ${n} frames` : ""} to ${SP.ROWS[r].label} ${drag.target.c + 1}`;
  }
  function autoScroll(e) {
    const box = $("#edRows");
    if (!box) return;
    const b = box.getBoundingClientRect();
    if (e.clientY < b.top + 28) box.scrollTop -= 14;
    else if (e.clientY > b.bottom - 28) box.scrollTop += 14;
  }
  function endDrag() {
    if (ghost) ghost.remove();
    ghost = null;
    document.body.style.cursor = "";
    if (root) clearAim();
  }

  /* ───────── events (bound once; they check that the editor is showing) ───────── */
  function bind() {
    const file = document.createElement("input");
    file.type = "file"; file.accept = "image/png,image/webp,image/gif,image/jpeg"; file.multiple = true; file.hidden = true; file.id = "edFile";
    document.body.appendChild(file);
    file.addEventListener("change", () => {
      const fs = Array.from(file.files || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      file.value = "";
      if (fs.length) pasteFiles(fs);
    });

    document.addEventListener("pointerdown", (e) => {
      if (!active || e.button !== 0 || !E.pet) return;
      const cell = e.target.closest(".ed .cell");
      if (!cell) return;
      e.preventDefault();
      // no mousedown follows, so commit a field being edited by hand
      if (document.activeElement && document.activeElement.matches("input, select")) document.activeElement.blur();
      const r = +cell.dataset.r, c = +cell.dataset.c, k = key(r, c), mod = e.ctrlKey || e.metaKey;
      if (!mod && !e.shiftKey && !sel.includes(k)) select(r, c, "only");
      drag = { r, c, k, x: e.clientX, y: e.clientY, on: false, ctrl: mod, shift: e.shiftKey, target: null };
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (!drag.on) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
        startDrag();
      }
      ghost.style.left = e.clientX + "px";
      ghost.style.top = e.clientY + "px";
      aim(e);
      autoScroll(e);
    });
    window.addEventListener("pointerup", () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.on) {
        if (d.ctrl) select(d.r, d.c, "toggle");
        else if (d.shift) select(d.r, d.c, "range");
        else select(d.r, d.c, "only");
        return;
      }
      endDrag();
      const t = d.target;
      if (!t) return;
      if (t.mode === "swap") {
        const a = { r: d.r, c: d.c };
        if (a.r !== t.r || a.c !== t.c) swap(a, t);
        return;
      }
      insertFrames(d.items, t.r, t.c, t.mode === "copy");
    });
    window.addEventListener("pointercancel", () => { if (drag) { drag = null; endDrag(); } });

    document.addEventListener("click", (e) => {
      if (!active) return;
      const z = e.target.closest("[data-zoom]");
      if (z) {
        zoom = z.dataset.zoom;
        ls("cc.ed.zoom", zoom);
        const ed = root.querySelector(".ed");
        if (ed) ed.style.setProperty("--cw", ZOOM[zoom]);
        root.querySelectorAll("[data-zoom]").forEach((b) => b.classList.toggle("on", b === z));
        return;
      }
      const rh = e.target.closest(".ed .rh[data-row]");
      if (rh) return selectRow(+rh.dataset.row);
      const b = e.target.closest("[data-ed]");
      if (!b || b.disabled) return;
      const r = focus ? focus.r : 0;
      const acts = {
        open: () => open(b.dataset.id),
        undo: () => step(true), redo: () => step(false),
        save: () => save(false), "save-copy": () => save(true),
        "add-look": () => edit("Add look rows", () => setRows(11)),
        "drop-look": () => edit("Remove look rows", () => setRows(9)),
        "flip-h": () => flipSel(true), "flip-v": () => flipSel(false),
        copy: copySel, paste: pasteClip, dup: duplicate, clear: clearSel,
        nudge: () => { const s = e.shiftKey ? 8 : 1; nudge(+b.dataset.dx * s, +b.dataset.dy * s); },
        replace: () => $("#edFile").click(),
        "n-dec": () => setFrames(r, E.rowFrames[r] - 1), "n-inc": () => setFrames(r, E.rowFrames[r] + 1),
        "t-fast": () => setTimes(r, (a) => a.forEach((v, i) => (a[i] = v * 0.8)), "Faster"),
        "t-slow": () => setTimes(r, (a) => a.forEach((v, i) => (a[i] = v * 1.25)), "Slower"),
        "t-reset": () => resetTimes(r),
        "pv-play": pvToggle, "pv-back": () => pvStep(-1), "pv-step": () => pvStep(1),
        "pv-loop": () => setLoop(true), "pv-codex": () => setLoop(false),
      };
      if (acts[b.dataset.ed]) acts[b.dataset.ed]();
    });

    document.addEventListener("change", (e) => {
      if (!active || !E.pet) return;
      const t = e.target, r = focus ? focus.r : 0;
      if (t.id === "edPick") return void open(t.value);
      if (t.id === "edName") { const v = t.value.trim(); if (v) edit("Rename", () => { E.name = v; }); else t.value = E.name; return; }
      if (t.id === "edDesc") return void edit("Description", () => { E.description = t.value.trim(); });
      if (t.id === "edAll" || t.dataset.ms != null) {
        const v = Math.round(+t.value);
        if (!(v >= 16 && v <= 60000)) { toast("Use a duration from 16 to 60000 ms", { bad: true }); drawSide(); return; }
        if (t.id === "edAll") setTimes(r, (a) => a.fill(v));
        else setTimes(r, (a) => { a[+t.dataset.ms] = v; });
      }
    });

    document.addEventListener("keydown", (e) => {
      if (!active || !E.pet || document.querySelector(".ov")) return;
      const k = e.key, mod = e.ctrlKey || e.metaKey, lower = k.length === 1 ? k.toLowerCase() : k;
      if (mod && lower === "s") { e.preventDefault(); save(e.shiftKey); return; }
      if (e.target.closest && e.target.closest("input, textarea, select")) { if (k === "Escape" || k === "Enter") e.target.blur(); return; }
      if (k === "Escape" && drag) { drag = null; endDrag(); return; }
      if (mod && lower === "z") { e.preventDefault(); step(!e.shiftKey); return; }
      if (mod && lower === "y") { e.preventDefault(); step(false); return; }
      if (mod && lower === "c") { e.preventDefault(); copySel(); return; }
      if (mod && lower === "x") { e.preventDefault(); copySel(); clearSel(); return; }
      if (mod && lower === "d") { e.preventDefault(); duplicate(); return; }
      if (mod && lower === "a") { e.preventDefault(); if (focus) selectRow(focus.r); return; }
      const arrow = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[k];
      if (arrow && mod) { e.preventDefault(); const s = e.shiftKey ? 8 : 1; nudge(arrow[1] * s, arrow[0] * s); return; }
      if (arrow && e.altKey) { e.preventDefault(); if (arrow[1]) shiftFrames(arrow[1]); return; }
      if (arrow) { e.preventDefault(); moveFocus(arrow[0], arrow[1], e.shiftKey); return; }
      if (mod || e.altKey) return;
      if (k === "Delete" || k === "Backspace") { e.preventDefault(); clearSel(); }
      else if (lower === "h") flipSel(true);
      else if (lower === "v") flipSel(false);
      else if (k === " ") { e.preventDefault(); pvToggle(); }
      else if (k === ",") pvStep(-1);
      else if (k === ".") pvStep(1);
      else if (k === "Escape" && focus) select(focus.r, focus.c, "only");
    });

    document.addEventListener("paste", (e) => {
      if (!active || !E.pet || !focus || document.querySelector(".ov")) return;
      if (e.target.closest && e.target.closest("input, textarea")) return;
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.startsWith("image/"));
      e.preventDefault();
      if (files.length) pasteFiles(files); else pasteClip();
    });

    // look rows: the preview faces the cursor while it's over the stage
    document.addEventListener("pointermove", (e) => {
      if (!active || !E.pet || drag || !focus || !isLook(focus.r)) return;
      const st = $("#pvStage");
      if (!st) return;
      const rect = st.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      const f = inside ? SP.lookFrame(rect, { x: e.clientX, y: e.clientY }, 2) : null;
      const was = PV.hover;
      PV.hover = f;
      if (f || was) { pvShow(); if (!f) pvRun(); else clearTimeout(PV.timer); }
    });
  }

  CC.editor = {
    init(h) { host = h; bind(); },
    mount(el) {
      root = el;
      active = true;
      const target = want || E.id || (host.activeId && host.activeId()) || (host.pets()[0] || {}).id;
      want = null;
      render();
      if (target && target !== E.id) open(target);
    },
    leave() {
      if (!active) return;
      active = false;
      clearTimeout(PV.timer);
      PV.timer = null;
      if (drag) { drag = null; endDrag(); }
    },
    edit(id) { if (active) open(id); else want = id; },
    petsChanged() {
      if (!active) return;
      if (E.pet) syncPicker(); else render();
    },
    dirty: isDirty,
  };
})();
