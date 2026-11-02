/* Claude Companion — themes (CC.themes) in the shared Pocket theme format (Collegiapp's docs/THEMES.md), the JSON
   Collegiapp and PocketCanvas import and export too, so a theme made for one works in all three:
     { "pocketTheme": 1, "id", "name", "by", "note", "look": "pocket" | "standard", "scheme": "light" | "dark",
       "tokens": { bg … k6 }, "css": "optional extra CSS" }
   Ported from PocketCanvas's src/lib/themes.js: normalize() reads a theme out of a file or a chatbot reply and checks
   its contrast (WCAG 2.x), fix() repairs it, prompt() is the chatbot prompt. apply() writes the tokens onto
   pocket.css's variables (the table is in CLAUDE.md) and sets html[data-look] and [data-scheme]; standard.css draws
   the Standard look. Pocket Cream and Night are pocket.css's own palettes, so they only set the scheme. Claude and
   Claude Dark also set html[data-claude], which claude.css finishes like the Claude desktop app. pills() is the pet
   window's share: its colours and look, never the theme's CSS. Load after ui.js. */
(function () {
  const CC = window.CC;

  const KEYS = ["bg", "bg2", "surface", "surface2", "line", "text", "text2", "text3", "chrome-bg", "chrome-fg", "accent", "on-accent",
    "warn", "bad", "on-bad", "ok", "acc2", "disp-bg", "disp-fg", "disp-hot", "disp-bad", "k1", "k2", "k3", "k4", "k5", "k6"];
  const T = (look, scheme, id, name, note, tk) => ({ pocketTheme: 1, id, name, note, by: "Claude Companion", look, scheme, builtin: true,
    tokens: Object.fromEntries(KEYS.map((k, i) => [k, tk[i]])) });
  // `claude` never leaves the app: an exported Claude theme is a Standard theme in Claude's colours
  const C = (...a) => Object.assign(T(...a), { claude: true });

  // Claude and Claude Dark (the default) are the Claude desktop app's ivory, clay and warm charcoal, the clay deepened
  // a little in the light one so white reads on it; Pocket Cream and Night are Collegiapp's P9 and P11; Standard and
  // Standard Dark are PocketCanvas's, value for value
  const BUILTIN = [
    C("standard", "light", "claude", "Claude", "Ivory and clay, like the Claude desktop app", ["#faf9f5", "#ffffff", "#ffffff", "#f0eee6", "#e0ded4", "#141413", "#3d3d3a", "#6b6a64", "#1f1e1d", "#faf9f5", "#bc5a38", "#ffffff",
      "#8f5a06", "#b53333", "#ffffff", "#5e7f3d", "#3a6ea8", "#f0eee6", "#141413", "#f7e3c1", "#f6d9cf", "#c6613f", "#3a6ea8", "#5e7f3d", "#8e5ba6", "#a87516", "#73726c"]),
    C("standard", "dark", "claude-dark", "Claude Dark", "Warm charcoal and clay, like Claude in dark mode", ["#262624", "#30302e", "#30302e", "#3a3a37", "#4a4944", "#faf9f5", "#c2c0b6", "#a8a69d", "#141413", "#faf9f5", "#d97757", "#141413",
      "#e3a64a", "#ef7f6b", "#141413", "#93b06f", "#7ba7d6", "#3a3a37", "#faf9f5", "#5c4419", "#5e2c24", "#d97757", "#7ba7d6", "#93b06f", "#c391d6", "#d9a94e", "#a8a69d"]),
    T("pocket", "light", "pocket-cream", "Pocket Cream", "Light handheld plastic, orange keys, reflective LCD", ["#e6e2d8", "#fbf9f4", "#f6f3ec", "#ebe7dd", "#d3ccbd", "#1b1915", "#4a453c", "#6a645a", "#2a2722", "#f6f3ec", "#ff5b1f", "#1b1915",
      "#9a5b00", "#c8341b", "#ffffff", "#2e7d32", "#2f6fde", "#b1bd93", "#1f2a17", "#e9b45a", "#ee8f6e", "#2f6fde", "#ff5b1f", "#2e8b57", "#b03aa8", "#c27a00", "#5b5548"]),
    T("pocket", "dark", "pocket-night", "Pocket Night", "Graphite plastic and a backlit LCD for late study", ["#1a1917", "#2a2926", "#262522", "#302e2a", "#3f3c36", "#f4efe5", "#d0c9ba", "#a39c8d", "#0f0e0d", "#ece6da", "#ff6a2b", "#1b1915",
      "#f0b54a", "#ff7a5c", "#1b1915", "#62c470", "#7aa5ff", "#45b3a1", "#04211c", "#e2b04f", "#ef8b6c", "#7aa5ff", "#ff7a3d", "#4fbf86", "#d77bd0", "#e3a640", "#a39c8d"]),
    T("standard", "light", "standard-light", "Standard", "Plain and bright: white cards, grey hairlines, one blue accent", ["#f4f4f2", "#ffffff", "#ffffff", "#f1f1ef", "#dededa", "#1c1c1b", "#444441", "#686864", "#1c1c1b", "#fafaf9", "#2b59c3", "#ffffff",
      "#8a5a00", "#c42b1c", "#ffffff", "#2a7a3b", "#0f7b8a", "#f1f1ef", "#1c1c1b", "#fbeccc", "#fbe0dc", "#2b59c3", "#d9480f", "#2f8f4e", "#a23d9a", "#b7791f", "#686864"]),
    T("standard", "dark", "standard-dark", "Standard Dark", "The plain look on charcoal", ["#141516", "#1d1e20", "#1b1c1e", "#26272a", "#333539", "#ededec", "#c9c9c6", "#9a9a96", "#0c0c0d", "#ededec", "#7ea2ff", "#0f1420",
      "#e8b04a", "#ff7b6b", "#1a0d0b", "#6cc47f", "#5fc4d0", "#26272a", "#ededec", "#4a3a12", "#4d201b", "#7ea2ff", "#ff8a4c", "#5cc489", "#d58ad0", "#e3b04f", "#9a9a96"]),
  ];
  const byId = (id) => BUILTIN.find((t) => t.id === id);

  // ── colour maths (WCAG 2.x) ──
  const hex = (s) => { s = String(s || "").trim().toLowerCase(); if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s.slice(1).replace(/./g, "$&$&"); return /^#[0-9a-f]{6}$/.test(s) ? s : null; };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (h) => { const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b, t) => "#" + rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");

  // [foreground, background, minimum]: THEMES.md's contrast table
  const PAIRS = [["text", "surface", 4.5], ["text2", "surface", 4.5], ["text3", "surface", 4.5], ["text3", "bg", 4.5], ["text3", "surface2", 4.5],
    ["on-accent", "accent", 4.5], ["chrome-fg", "chrome-bg", 4.5], ["on-bad", "bad", 4.5], ["disp-fg", "disp-bg", 4.5], ["disp-fg", "disp-hot", 4.5], ["disp-fg", "disp-bad", 4.5],
    ["warn", "surface", 3], ["bad", "surface", 3], ["ok", "surface", 3]];
  const checks = (tk) => PAIRS.map(([f, b, min]) => ({ f, b, min, r: contrast(tk[f], tk[b]) })).filter((c) => c.r < c.min);

  /** Repair failing pairs by moving the foreground toward black or white, whichever the background needs. */
  function fix(theme) {
    const tk = Object.assign({}, theme.tokens);
    for (let pass = 0; pass < 3; pass++) for (const c of checks(tk)) {
      const toward = lum(tk[c.b]) > 0.18 ? "#000000" : "#ffffff";
      let t = 0; while (t < 1 && contrast(tk[c.f], tk[c.b]) < c.min) { t += 0.05; tk[c.f] = mix(theme.tokens[c.f] || tk[c.f], toward, Math.min(1, t)); }
    }
    return Object.assign({}, theme, { tokens: tk });
  }

  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  // Theme CSS may restyle anything, but never loads anything: no @import, no url() other than data: URLs
  const safeCss = (css) => String(css || "").slice(0, 60000).replace(/@import[^;]*;?/gi, "").replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, "none");

  /**
   * Read a theme from anything: an object, JSON text, or a chatbot reply with prose and code fences around the JSON.
   * Accepts Collegiapp v1 theme packs too (palette.tokens with p-* names). Returns { theme, warnings, lowContrast } or { error }.
   */
  function normalize(input) {
    let o = input;
    if (typeof o === "string") {
      const s = o.indexOf("{"), e = o.lastIndexOf("}");
      if (s < 0 || e < s) return { error: "No JSON object found. Paste the whole reply, or a theme file." };
      try { o = JSON.parse(o.slice(s, e + 1)); } catch (err) { return { error: "That JSON doesn't parse: " + err.message }; }
    }
    if (!o || typeof o !== "object") return { error: "That isn't a theme." };
    let src = o.tokens || (o.palette && o.palette.tokens) || o.colors || {};
    // Collegiapp v1 names → shared names
    const V1 = { "p-surface": "surface", "p-surface2": "surface2", "p-line": "line", "p-text": "text", "p-text2": "text2", "p-text3": "text3", "p-acc": "accent", "p-on-acc": "on-accent",
      "p-disp-bg": "disp-bg", "p-disp-fg": "disp-fg", "p-disp-hot": "disp-hot", "p-disp-bad": "disp-bad" };
    src = Object.fromEntries(Object.entries(src).map(([k, v]) => [V1[k] || String(k).replace(/^--(pc-)?/, ""), v]));
    const look = o.look === "standard" ? "standard" : "pocket";
    const bgGuess = hex(src.bg) || hex(src.surface);
    const scheme = o.scheme === "dark" || o.scheme === "light" ? o.scheme : bgGuess && lum(bgGuess) < 0.2 ? "dark" : "light";
    // missing colours come from the plain built-in of the look and scheme, never Claude's
    const base = BUILTIN.find((t) => t.look === look && t.scheme === scheme && !t.claude);
    const warnings = [];
    const tokens = {};
    let missing = 0;
    for (const k of KEYS) { const v = hex(src[k]); if (v) tokens[k] = v; else { tokens[k] = base.tokens[k]; missing++; } }
    if (missing === KEYS.length) return { error: "None of the colours were readable. Tokens are hex colours like #1b1915." };
    if (missing) warnings.push(`${missing} colour${missing > 1 ? "s" : ""} missing, taken from ${base.name}.`);
    const name = String(o.name || "My theme").slice(0, 48);
    const theme = { pocketTheme: 1, id: slug(o.id || name) || "theme", name, by: String(o.by || o.author || "").slice(0, 48), note: String(o.note || o.description || "").slice(0, 120),
      look, scheme, tokens, css: safeCss(o.css) };
    if (byId(theme.id)) theme.id = "my-" + theme.id;
    const bad = checks(tokens);
    if (bad.length) warnings.push("Low contrast: " + bad.map((c) => `${c.f} on ${c.b} ${c.r.toFixed(1)}:1 (needs ${c.min})`).join(", ") + ".");
    return { theme, warnings, lowContrast: bad.length > 0 };
  }

  /** The file a theme exports as: the shared format, without the app's own fields. */
  const file = (t) => ({ pocketTheme: 1, id: t.id, name: t.name, by: t.by, note: t.note, look: t.look, scheme: t.scheme, tokens: t.tokens, css: t.css || undefined });

  /** Every theme: the built-ins, then the imported ones in settings `themes`. */
  const all = (s) => BUILTIN.concat(((s && s.themes) || []).map((t) => normalize(t).theme).filter(Boolean));

  const darkMQ = matchMedia("(prefers-color-scheme: dark)");
  /** The built-in dark theme for a day theme: Claude Dark for Claude, else its look's (Pocket Night or Standard Dark). */
  const darkOf = (t) => (t.claude ? byId("claude-dark") : BUILTIN.find((x) => x.scheme === "dark" && x.look === t.look && !x.claude)) || BUILTIN[1];
  /** The day slot: `theme`, or Claude when it's gone. */
  const dayOf = (s) => all(s).find((t) => t.id === (s && s.theme)) || BUILTIN[0];
  /** The night slot: `nightTheme`, light or dark, or the day theme's dark built-in (darkOf) when it's gone. */
  const nightOf = (s) => all(s).find((t) => t.id === (s && s.nightTheme)) || darkOf(dayOf(s));
  /** The slot in effect: "night" while the system is dark and `night` isn't off, else "day". */
  const slotNow = (s) => ((s && s.night) !== "off" && darkMQ.matches ? "night" : "day");
  /** The theme to show: the slot in effect's. */
  const pick = (s) => (slotNow(s) === "night" ? nightOf(s) : dayOf(s));

  // token → pocket.css variable: `--<token>` but for these three; the rest of pocket.css derives from them
  const VAR = { surface2: "--surface-2", text2: "--text-2", text3: "--text-3" };
  // and what pocket.css hard-codes per palette: the checkerboard, and the ink on hot and bad LCDs (disp-fg here)
  const EXTRA = [["--desk-c", "bg"], ["--check-a", "surface2"], ["--check-b", "surface"], ["--disp-ink", "disp-fg"]];
  /** Paint the main window in a theme: its tokens as pocket.css variables, html[data-look] and [data-scheme], and its CSS. */
  function apply(t) {
    const root = document.documentElement, st = root.style, own = t.builtin && t.look === "pocket";
    for (const k of KEYS) own ? st.removeProperty(VAR[k] || "--" + k) : st.setProperty(VAR[k] || "--" + k, t.tokens[k]);
    for (const [v, k] of EXTRA) own ? st.removeProperty(v) : st.setProperty(v, t.tokens[k]);
    root.dataset.look = t.look;
    root.dataset.scheme = t.scheme;
    root.dataset.theme = t.id;
    root.toggleAttribute("data-claude", !!t.claude);
    let css = document.getElementById("theme-css");
    if (!css) { css = document.createElement("style"); css.id = "theme-css"; document.head.appendChild(css); }
    css.textContent = safeCss(t.css);
  }

  /** The pet's pills in theme `t`, as pet.css variables. Pocket pills are the graphite island on the theme's chrome
      (pet.css's own values are Pocket Cream's, so it sets none), the status colours lifted until they read on it
      (3:1); Standard pills are the theme's surface cards with its inks, hairline and course colours. The theme's CSS
      stays in the main window: it's written for that page, and the pet's window is transparent. */
  function pills(t) {
    if (t.id === "pocket-cream") return {};
    const k = t.tokens, std = t.look === "standard";
    const plate = std ? k.surface : k["chrome-bg"], ink = std ? k.text : k["chrome-fg"], away = lum(plate) > 0.18 ? "#000000" : "#ffffff";
    const reads = (c) => { let v = c; for (let s = 0.05; s <= 1 && contrast(v, plate) < 3; s += 0.05) v = mix(c, away, s); return v; };
    const v = { "--chrome-bg": plate, "--chrome-hi": std ? plate : mix(plate, "#ffffff", 0.06), "--chrome-fg": ink,
      "--chrome-2": std ? k.text2 : mix(ink, plate, 0.22), "--chrome-3": std ? k.text3 : mix(ink, plate, 0.45), "--line": k.line,
      "--accent": reads(k.accent), "--ok": reads(k.ok), "--warn": reads(k.warn), "--bad": reads(k.bad),
      "--disp-bg": k["disp-bg"], "--disp-fg": k["disp-fg"], "--disp-hot": k["disp-hot"], "--disp-hot-fg": k["disp-fg"] };
    if (std) for (let i = 1; i <= 6; i++) v["--k" + i] = k["k" + i];
    return v;
  }

  /** The prompt for a chatbot. `idea` is the user's description. */
  function prompt(idea) {
    return `Make a colour theme for my Pocket apps (Collegiapp, PocketCanvas, Claude Companion). Reply with only one JSON object, no other text.

My idea: ${idea || "surprise me, something calm I can study with for hours"}

Format:
{"pocketTheme":1,"name":"…","look":"pocket","scheme":"light","tokens":{"bg":"#…", …}}

"look" is "pocket" (a handheld device: raised keys, dark label bands, small LCD screens) or "standard" (a plain modern UI: flat surfaces and thin borders). "scheme" is "light" or "dark".

Tokens, all hex #rrggbb:
- bg: page body behind the cards; bg2: recessed fields and inputs
- surface: card fill; surface2: key faces, wells, idle pills; line: hairlines and borders
- text: titles; text2: body text; text3: meta and placeholders
- chrome-bg, chrome-fg: label bands and dark keys, and the text on them
- accent, on-accent: the single most important action and the text on it (it means "do this", so not decoration)
- warn: due soon; bad, on-bad: overdue and the text on it; ok: done
- acc2: events and secondary marks
- disp-bg, disp-fg: the LCD screen and its digits; disp-hot, disp-bad: the LCD backlight when due soon or overdue (disp-fg is drawn on both)
- k1 k2 k3 k4 k5 k6: six clearly different course colours that read on surface

Rules: text, text2 and text3 reach 4.5:1 contrast on surface and on bg. on-accent on accent, chrome-fg on chrome-bg, on-bad on bad, and disp-fg on disp-bg, disp-hot and disp-bad all reach 4.5:1. warn, bad and ok reach 3:1 on surface. No gradients and no neon; pick colours that fit the idea.`;
  }
  /** A chatbot link that opens with the prompt filled in. Claude is the default; any chatbot works with Copy. */
  const BOTS = { claude: (p) => "https://claude.ai/new?q=" + encodeURIComponent(p), chatgpt: (p) => "https://chatgpt.com/?q=" + encodeURIComponent(p) };

  /** A small drawing of a theme for its card: the page, a card with its band and LCD, the accent key, three course colours. */
  function preview(t) {
    const k = t.tokens, pocket = t.look === "pocket", r = pocket ? 6 : 3, e = CC.esc;
    return `<svg class="tsw" viewBox="0 0 180 76" role="img" aria-label="${e(t.name)} colours"><rect width="180" height="76" fill="${k.bg}"/>
      <rect x="10.5" y="9.5" width="159" height="57" rx="${r}" fill="${k.surface}" stroke="${k.line}"/>
      ${pocket ? `<path d="M10 ${9 + r}a${r} ${r} 0 0 1 ${r}-${r}h${160 - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${14 - r}H10z" fill="${k["chrome-bg"]}"/>` : `<rect x="11" y="23" width="158" height="1" fill="${k.line}"/>`}
      <rect x="16" y="14" width="40" height="4" rx="1" fill="${pocket ? k["chrome-fg"] : k.text}"/>
      <rect x="18" y="30" width="54" height="28" rx="${pocket ? 4 : 2}" fill="${k["disp-bg"]}"/><rect x="24" y="40" width="34" height="8" rx="1" fill="${k["disp-fg"]}"/>
      <rect x="80" y="31" width="70" height="4" rx="1" fill="${k.text}"/><rect x="80" y="39" width="52" height="3" rx="1" fill="${k.text3}"/>
      <rect x="80" y="48" width="34" height="11" rx="${pocket ? 4 : 2}" fill="${k.accent}"/><rect x="86" y="52" width="22" height="3" rx="1" fill="${k["on-accent"]}"/>
      ${["k1", "k2", "k3"].map((c, i) => `<rect x="${122 + i * 11}" y="50" width="7" height="7" rx="${pocket ? 1 : 3.5}" fill="${k[c]}"/>`).join("")}</svg>`;
  }

  CC.themes = { KEYS, BUILTIN, byId, all, normalize, fix, checks, contrast, apply, pills, pick, dayOf, nightOf, slotNow, darkOf, prompt, BOTS, preview, file, darkMQ };
})();
