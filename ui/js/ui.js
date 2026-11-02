/* Claude Companion — shared UI plumbing on window.CC: the Tauri bridge, 9×9 pixel icons (Collegiapp's PIX
   plus the companion's own), the theme, toasts, and the custom window frame (the top bar is the title bar).
   Classic script, no build step; load first. */
(function () {
  const CC = (window.CC = window.CC || {});
  const T = window.__TAURI__;
  CC.live = !!(T && T.core);
  CC.invoke = (cmd, args, opts) => (CC.live ? T.core.invoke(cmd, args, opts) : Promise.reject(new Error("Claude Companion isn't running")));
  CC.on = (ev, fn) => (CC.live ? T.event.listen(ev, (e) => fn(e.payload)) : Promise.resolve(() => {}));
  CC.win = () => (CC.live ? T.window.getCurrentWindow() : null);
  CC.mac = /Mac/.test(navigator.platform || navigator.userAgent);
  CC.windows = /Win/.test(navigator.platform || navigator.userAgent);

  // Sheets come over the app's `pet` scheme (pets.rs serve); Windows maps custom schemes to http://<scheme>.localhost
  CC.petUrl = (id, file, stamp) =>
    (CC.windows ? "http://pet.localhost/" : "pet://localhost/") + encodeURIComponent(id) + "/" + encodeURIComponent(file) + "?v=" + (stamp || 0);

  // write_pet takes raw bytes: u32 LE header length, the JSON header, then the image (lib.rs)
  CC.writePet = (head, bytes) => {
    const h = new TextEncoder().encode(JSON.stringify(head));
    const body = new Uint8Array(4 + h.length + bytes.byteLength);
    new DataView(body.buffer).setUint32(0, h.length, true);
    body.set(h, 4);
    body.set(new Uint8Array(bytes), 4 + h.length);
    return CC.invoke("write_pet", body);
  };
  CC.openUrl = (u) => (CC.live && T.opener ? T.opener.openUrl(u) : window.open(u, "_blank"));

  CC.esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  CC.$ = (sel, el) => (el || document).querySelector(sel);
  CC.$$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  /* Pixel icons: nine rows of "#" (lit) and "." joined by "|", drawn as crisp SVG rects (Collegiapp app.js). */
  const PIX = {
    paw: "..##.##..|..##.##..|##.....##|##.....##|...###...|..#####..|.#######.|.#######.|..#####..",
    pets: "#.#...#.#|#.#...#.#|.........|..#####..|.#######.|.#######.|..#####..|.........|.........",
    edit: ".......##|......###|.....###.|....###..|...###...|..###....|.###.....|##.......|#........",
    claude: "....#....|.#..#..#.|..#.#.#..|...###...|#########|...###...|..#.#.#..|.#..#..#.|....#....",
    gear: "...###...|.#.###.#.|..#####..|###...###|###...###|###...###|..#####..|.#.###.#.|...###...",
    play: "..#......|..##.....|..###....|..####...|..#####..|..####...|..###....|..##.....|..#......",
    pause: ".........|.##...##.|.##...##.|.##...##.|.##...##.|.##...##.|.##...##.|.##...##.|.........",
    step: ".#.....#.|.##....#.|.###...#.|.####..#.|.#####.#.|.####..#.|.###...#.|.##....#.|.#.....#.",
    back: ".#.....#.|.#....##.|.#...###.|.#..####.|.#.#####.|.#..####.|.#...###.|.#....##.|.#.....#.",
    check: ".........|........#|.......##|......##.|#....##..|##..##...|.####....|..##.....|.........",
    okc: "..#####..|.#.....#.|#......##|#.....#.#|##...#..#|#.#.#...#|#..#....#|.#.....#.|..#####..",
    warn: "....#....|...###...|...#.#...|..##.##..|..##.##..|.###.###.|.#######.|###.#.###|#########",
    spin: "...###...|.##...##.|.#.....#.|#.......#|#.......#|.........|.........|.........|.........",
    clock: "..#####..|.#..#..#.|#...#...#|#...#...#|#...###.#|#.......#|#.......#|.#.....#.|..#####..",
    close: ".........|.#.....#.|..#...#..|...#.#...|....#....|...#.#...|..#...#..|.#.....#.|.........",
    plus: ".........|....#....|....#....|....#....|.#######.|....#....|....#....|....#....|.........",
    bell: "....#....|..#####..|.#######.|.#######.|.#######.|.#######.|#########|.........|...###...",
    minus: ".........|.........|.........|.........|.#######.|.........|.........|.........|.........",
    paste: "..#####..|.##...##.|.#######.|.#.....#.|.#.###.#.|.#.....#.|.#.###.#.|.#.....#.|.#######.",
    trash: "...###...|#########|.#.....#.|.#.#.#.#.|.#.#.#.#.|.#.#.#.#.|.#.#.#.#.|.#.....#.|..#####..",
    copy: "#####....|#...#....|#...#####|#...#...#|#####...#|....#...#|....#...#|....#####|.........",
    flip: "....#....|.#..#..#.|##..#..##|###.#.###|##..#..##|.#..#..#.|....#....|....#....|....#....",
    flipv: ".........|.#######.|..#####..|...###...|#########|...###...|..#####..|.#######.|.........",
    undo: ".........|..#......|.##......|#######..|.##....#.|..#.....#|........#|.......#.|..#####..",
    redo: ".........|......#..|......##.|..#######|.#....##.|#.....#..|#........|.#.......|..#####..",
    up: "....#....|...###...|..#####..|.#######.|....#....|....#....|....#....|....#....|.........",
    down: ".........|....#....|....#....|....#....|....#....|.#######.|..#####..|...###...|....#....",
    left: ".........|...#.....|..##.....|.#######.|#########|.#######.|..##.....|...#.....|.........",
    right: ".........|.....#...|.....##..|.#######.|#########|.#######.|.....##..|.....#...|.........",
    folder: ".........|####.....|#...#####|#.......#|#.......#|#.......#|#.......#|#########|.........",
    save: "########.|#.....#.#|#.....#.#|#######.#|#.......#|#.#####.#|#.#...#.#|#.#...#.#|#########",
    image: "#########|#.......#|#..##...#|#..##...#|#.......#|#...#...#|#..###.##|#.#####.#|#########",
    eye: ".........|..#####..|.#.....#.|#...#...#|#..###..#|#...#...#|.#.....#.|..#####..|.........",
    link: ".........|.###.....|#...#....|#..#.....|.#..#..#.|.....#..#|....#...#|.....###.|.........",
    ext: "....#####|.......##|......#.#|.....#..#|....#...#|...#.....|..#......|.#.......|#........",
    chev: ".........|.........|.#.....#.|..#...#..|...#.#...|....#....|.........|.........|.........",
    chevu: ".........|.........|....#....|...#.#...|..#...#..|.#.....#.|.........|.........|.........",
    more: ".........|.........|.........|.........|##.##.##.|.........|.........|.........|.........",
    grid: "###.###.#|###.###.#|###.###.#|.........|###.###.#|###.###.#|###.###.#|.........|###.###.#",
    film: "#.#####.#|#########|#.#...#.#|#.#...#.#|#########|#.#...#.#|#.#...#.#|#########|#.#####.#",
    timer: "...###...|....#....|..#####..|.#.....#.|#...#...#|#...#...#|#..#....#|.#.....#.|..#####..",
    wmin: ".........|.........|.........|.........|.........|.........|.#######.|.#######.|.........",
    wmax: ".........|.#######.|.#######.|.#.....#.|.#.....#.|.#.....#.|.#.....#.|.#######.|.........",
    bolt: ".....##..|....##...|...##....|..######.|.....##..|....##...|...##....|..##.....|.##......",
  };
  const ICONS = {};
  for (const n in PIX) ICONS[n] = PIX[n].split("|").map((row, y) => row.replace(/#+/g, (run, x) => `M${x} ${y}h${run.length}v1h-${run.length}z`).replace(/\./g, "")).join("");
  CC.ic = (n, c) => `<svg class="i${c ? " " + c : ""}" viewBox="0 0 9 9" aria-hidden="true"><path d="${ICONS[n] || ""}"/></svg>`;

  /* Theme: Cream (P9) or Night (P11); "auto" follows the system. */
  const darkMQ = window.matchMedia && matchMedia("(prefers-color-scheme: dark)");
  let themePref = "auto";
  CC.applyTheme = (pref) => {
    themePref = pref || themePref;
    const dark = themePref === "dark" || (themePref === "auto" && darkMQ && darkMQ.matches);
    document.documentElement.dataset.scheme = dark ? "dark" : "light";
  };
  if (darkMQ) darkMQ.addEventListener("change", () => CC.applyTheme());

  /* Toasts: a message and at most one action; undo instead of confirm. */
  CC.toast = (msg, opts = {}) => {
    let box = CC.$(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = "toast" + (opts.bad ? " bad" : "");
    t.innerHTML = `<span>${CC.esc(msg)}</span>`;
    if (opts.action) {
      const b = document.createElement("button");
      b.className = "btn sm"; b.textContent = opts.action;
      b.onclick = () => { opts.onAction && opts.onAction(); t.remove(); };
      t.appendChild(b);
    }
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => t.remove(), opts.ms || 4200);
  };
  CC.fail = (e) => CC.toast(String((e && e.message) || e), { bad: true, ms: 7000 });

  /* A small modal question; resolves to the chosen button's value (null on Escape or a click outside). */
  CC.ask = (title, text, buttons) => new Promise((done) => {
    const ov = document.createElement("div");
    ov.className = "ov";
    ov.innerHTML = `<div class="panel dialog" role="dialog" aria-modal="true"><div class="ph"><span class="pt">${CC.esc(title)}</span></div>` +
      `<div class="pb"><div>${CC.esc(text)}</div><div class="actions">${buttons.map((b, i) => `<button class="btn${b.cls ? " " + b.cls : ""}" data-i="${i}">${CC.esc(b.label)}</button>`).join("")}</div></div></div>`;
    const close = (v) => { ov.remove(); document.removeEventListener("keydown", key, true); done(v); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); } };
    ov.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (b) close(buttons[+b.dataset.i].value);
      else if (e.target === ov) close(null);
    });
    document.addEventListener("keydown", key, true);
    document.body.appendChild(ov);
    const first = ov.querySelector(".btn.primary") || ov.querySelector(".btn");
    if (first) first.focus();
  });

  /* Custom frame (Windows, Linux): drag the top bar after 4 px, double-click maximizes; macOS keeps its lights. */
  CC.bindFrame = (bar) => {
    document.documentElement.dataset.frame = CC.mac ? "mac" : "own";
    if (!CC.live) return;
    const w = CC.win();
    let down = null;
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, select, a, .nv, [data-nodrag]")) return;
      down = { x: e.screenX, y: e.screenY };
    });
    bar.addEventListener("pointermove", (e) => {
      if (!down) return;
      if (Math.abs(e.screenX - down.x) + Math.abs(e.screenY - down.y) > 4) { down = null; w.startDragging(); }
    });
    window.addEventListener("pointerup", () => (down = null));
    bar.addEventListener("dblclick", (e) => { if (!e.target.closest("button, input, select, a, .nv")) w.toggleMaximize(); });
  };
  CC.winKeys = () => `<span class="winkeys" data-nodrag><button class="wk" data-wk="min" title="Minimize" aria-label="Minimize">${CC.ic("wmin")}</button><button class="wk" data-wk="max" title="Maximize" aria-label="Maximize">${CC.ic("wmax")}</button><button class="wk wk-x" data-wk="close" title="Close to the tray" aria-label="Close">${CC.ic("close")}</button></span>`;
  document.addEventListener("click", (e) => {
    const k = e.target.closest("[data-wk]");
    if (!k || !CC.live) return;
    const w = CC.win();
    ({ min: () => w.minimize(), max: () => w.toggleMaximize(), close: () => w.close() })[k.dataset.wk]();
  });

  CC.ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return s + " s ago";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    return Math.round(s / 3600) + " h ago";
  };
})();
