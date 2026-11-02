/* Claude Companion — shared UI plumbing on window.CC: the Tauri bridge, 9×9 pixel icons (Collegiapp's PIX
   plus the companion's own) and the Standard look's line icons, toasts, and the custom window frame (the top bar
   is the title bar). Themes are themes.js.
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
    sun: "....#....|.#.....#.|...###...|..#####..|#.#####.#|..#####..|...###...|.#.....#.|....#....",
    moon: "...#.....|.##......|.##......|###......|####.....|#####...#|.#######.|.#######.|...###...",
    // Collegiapp's kinds, for the countdown pills
    classes: "....#....|..##.##..|##.....##|..##.##.#|..#.#.#.#|..#...#.#|..#...#..|..#####..|.........",
    work: ".#####...|.#...##..|.#...###.|.#.....#.|.#.###.#.|.#.....#.|.#.###.#.|.#.....#.|.#######.",
    exams: "....#....|...#.#...|...#.#...|..#.#.#..|..#.#.#..|.#..#..#.|.#.....#.|#...#...#|#########",
    events: "....#....|....#....|...###...|#########|.#######.|..#####..|..##.##..|.##...##.|.#.....#.",
    ticket: ".........|#########|#...#...#|.#.....#.|.#..#..#.|#.......#|#...#...#|#########|.........",
    lab: ".#..#..#.|###.#..#.|.#..#..#.|.#..#.###|.#..#..#.|.#.###.#.|.#..#..#.|.#..#..#.|.#..#..#.",
  };
  const ICONS = {};
  for (const n in PIX) ICONS[n] = PIX[n].split("|").map((row, y) => row.replace(/#+/g, (run, x) => `M${x} ${y}h${run.length}v1h-${run.length}z`).replace(/\./g, "")).join("");
  /* Line icons for the Standard look (html[data-look="standard"]): 24 px strokes, the same names as PIX. Ones
     without a line version keep their pixels. Many are PocketCanvas's (src/lib/icons.js). */
  const LINE = {
    paw: "M12 13c-3 0-6 3.5-6 6 0 1.3 1 2 2.4 2h7.2c1.4 0 2.4-.7 2.4-2 0-2.5-3-6-6-6zM3.4 9.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM7.4 5.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM13.4 5.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0zM17.4 9.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0z",
    pets: "M5 20V6l4 3h6l4-3v14zM9.5 13.5h.01M14.5 13.5h.01",
    edit: "M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4",
    claude: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4",
    gear: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
    play: "M8 5l11 7-11 7V5z",
    pause: "M8 5v14M16 5v14",
    step: "M6 5l9 7-9 7V5zM18 5v14",
    back: "M18 5l-9 7 9 7V5zM6 5v14",
    check: "M5 12l5 5 9-10",
    okc: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6",
    warn: "M12 3 2 20h20L12 3zM12 10v4M12 17h.01",
    spin: "M12 3a9 9 0 0 1 9 9",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
    close: "M6 6l12 12M18 6L6 18",
    plus: "M12 5v14M5 12h14",
    bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0",
    minus: "M5 12h14",
    paste: "M9 3h6v3H9zM9 5H6v16h12V5h-3",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    flip: "M12 3v18M9 7l-5 5 5 5V7zM15 7l5 5-5 5V7z",
    flipv: "M3 12h18M7 9l5-5 5 5H7zM7 15l5 5 5-5H7z",
    undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
    redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
    up: "M12 19V5M6 11l6-6 6 6",
    down: "M12 5v14M6 13l6 6 6-6",
    left: "M19 12H5M11 6l-6 6 6 6",
    right: "M5 12h14M13 6l6 6-6 6",
    folder: "M3 6h6l2 2h10v11H3z",
    save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    ext: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    chev: "M6 9l6 6 6-6",
    chevu: "M6 15l6-6 6 6",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    film: "M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4",
    timer: "M12 7a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 11v3l2 1.5M10 3h4",
    wmin: "M6 12h12",
    wmax: "M6 6h12v12H6z",
    bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
    palette: "M12 3a9 9 0 0 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.5 1-2 2-2H18a3 3 0 0 0 3-3c0-5-4-11.5-9-11.5zM7.5 12h.01M9.5 7.5h.01M14.5 7.5h.01",
  };
  CC.ic = (n, c) => document.documentElement.dataset.look === "standard" && LINE[n]
    ? `<svg class="i line${c ? " " + c : ""}" viewBox="0 0 24 24" aria-hidden="true"><path d="${LINE[n]}"/></svg>`
    : `<svg class="i${c ? " " + c : ""}" viewBox="0 0 9 9" aria-hidden="true"><path d="${ICONS[n] || ""}"/></svg>`;

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
