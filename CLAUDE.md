# Claude Companion: notes for Claude

A Tauri 2 desktop pet that plays Codex pets 1:1 and shows Claude Code sessions in pills. See `README.md`.

## Invariants

- **Codex fidelity.** `ui/js/sprite.js` is the Codex sprite engine. Its header documents the formats, rows, timing,
  playback and look directions. Don't change Codex behaviour there. Companion-only extras live in pet.json under
  `rowFrames`, `claudeCompanion.timing` and `claudeCompanion.tilt`, and saving keeps every other key.
- **Buildless UI.** `ui/` is plain classic scripts on `window.CC`, with no bundler and no npm.
  - Main window: `ui.js → themes.js → sprite.js → editor.js → app.js`, CSS `pocket.css → app.css → standard.css → claude.css`.
  - Pet window: `ui.js → themes.js → sprite.js → pet.js`, CSS `pet.css`.
- **Pocket design** from Collegiapp (P9 Cream / P11 Night tokens, B8 keys, F3 bands, LCD inlays, 9×9 icons in
  `ui.js` PIX). Write UI strings in sentence case.
- **Themes** are the shared Pocket theme format (Collegiapp's `docs/THEMES.md`), ported from PocketCanvas's
  `src/lib/themes.js` into `ui/js/themes.js`. Built-ins: Claude and Claude Dark (the default day and night pair),
  Pocket Cream, Pocket Night, Standard and Standard Dark. Settings keep `theme`, `nightTheme`, `night` (auto · off) and the imported `themes`; the old
  auto · light · dark values migrate on load (`settings.rs`). "Switch theme at night" sits above the grid. Off is one
  theme: a click uses it. On shows a Day and a Night slot (tabs, starting on the slot in effect, `slotNow()`), and a
  click puts the theme in the selected slot and changes nothing else. Selecting the slot that isn't in effect
  previews its theme in the main window only, until it's deselected, Settings closes or the window hides. At night
  the Night slot shows whatever it holds, light or dark (`nightOf()`), falling back to the day theme's dark built-in
  when it's gone (`darkOf()`: Claude Dark for Claude, else Pocket Night or Standard Dark by look). Both windows show the theme `pick()` returns.
  `look: "standard"` is `html[data-look="standard"]`: `standard.css` (flat, one hairline,
  6–8 px radii, system-ui, line icons from `ui.js` LINE, no gradients, glow, blur or colour stripes). A new icon
  needs a PIX bitmap and, for Standard, a LINE path. Claude and Claude Dark are Standard themes in the Claude
  desktop app's colours with `claude: true`, which only the built-ins carry and exports drop: `apply()` and pet.js
  `paint()` set `html[data-claude]`, and `claude.css` (serif headings from Source Serif 4, 12 px cards, tabs as a
  soft fill, no heading rule) and pet.css's Claude section finish them like the app. Imported themes never take
  their missing colours from Claude's. `apply()` maps the tokens onto pocket.css's variables:

  | token | Companion variable |
  |---|---|
  | `bg` | `--bg`, `--desk-c` |
  | `bg2` | `--bg2` |
  | `surface`, `surface2` | `--surface`, `--surface-2` (also the checkerboard's `--check-b`, `--check-a`) |
  | `line` | `--line` |
  | `text`, `text2`, `text3` | `--text`, `--text-2`, `--text-3` |
  | `chrome-bg`, `chrome-fg` | `--chrome-bg`, `--chrome-fg` |
  | `accent`, `on-accent` | `--accent`, `--on-accent` (`--accent-soft` derives from it) |
  | `warn`, `bad`, `on-bad`, `ok`, `acc2` | the same names (`--warn-ink` derives from `warn`) |
  | `disp-bg`, `disp-fg`, `disp-hot`, `disp-bad` | the same names; `disp-fg` is also `--disp-ink`, the text on hot and bad LCDs |
  | `k1` … `k6` | `--k1` … `--k6` (only for a theme's own CSS: the main window draws no course colours) |
  | `scheme`, `look` | `html[data-scheme]` (pocket.css's dark shadows and scrim, `color-scheme`), `html[data-look]` |
  | `css` | `<style id="theme-css">`, last in the main window's head |

  Pocket Cream and Night are pocket.css's own `:root` and dark values, so `apply()` leaves those variables unset
  for them (their hot and bad LCD inks stay pocket.css's).

  The pet window paints the same theme with `pills()` instead (pet.js `paint()`, on every settings change and when
  the system goes light or dark). Its `:root` is Pocket Cream's island, so Cream sets nothing. Pocket themes keep the
  graphite island on the theme's `chrome-bg`/`chrome-fg` (`--chrome-hi`, `-2` and `-3` mixed from them), with
  `accent`, `ok`, `warn` and `bad` lifted until they reach 3:1 on it, and the theme's LCD colours (`disp-hot` with
  `disp-fg` for countdowns that are due soon). Standard themes turn the pills into `surface` cards with `text`…`text3`,
  a `line` hairline, their `k1`…`k6` for course colours (Pocket keeps Collegiapp's Night ones) and pet.css's Standard
  section. A theme's `css` never reaches the pet: it's written for the main window, and the pet's is transparent.
- **Updates** (`updater.rs`, desktop only): signed `latest.json` from GitHub Releases, checked 20 s after launch
  and every 6 h; installing is always the user's call (the update prompt from the toast, Settings or the tray's
  "Check for updates", which becomes "Update to x.y.z…"). The private key is `~/.tauri/claude-companion.key` and
  never goes in the repo; only its public key is in `tauri.conf.json`. `.github/workflows/release.yml` builds a
  draft release (Windows NSIS, universal macOS DMG, Linux) with `latest.json` from the `TAURI_SIGNING_PRIVATE_KEY`
  secret.
- **macOS** keeps native traffic lights over an overlay title bar: `tauri.macos.conf.json` repeats the whole
  `windows` array, because platform configs replace arrays.
- **Hooks never hurt Claude.** Hooks are async and run in exec form (`<exe> hook`). The hook client always exits
  0 and gives up after 400 ms. The bridge binds 127.0.0.1 only and refuses requests with an `Origin` header.
- **Windows.** Only `main` is created from the config. `pet` is `"create": false` and is built in `setup` after
  the state is managed. Its click-through comes from Rust polling the cursor against the rects the page reports
  (`set_hit_rects`). `fullscreen.rs` hides it while the foreground window covers its monitor, through Win32
  (SW_HIDE, then SWP_SHOWWINDOW | SWP_NOACTIVATE so it never takes focus), leaving tao's own visible flag and the
  user's `petVisible` switch alone.
- **Collegiapp is read-only.** `collegiapp.rs` reads `collegiapp.json` (Collegiapp's own store, owned by its
  Rust side) and never writes it; dismissals live in our settings. Its selection rules mirror Collegiapp's model
  (`crates/collegiapp-core/src/model.rs`: scheduled kinds, `is_open`, course colours). Countdowns always sit
  behind the Claude chats.
- **Codex is read-only too.** `codex.rs` pulls the pets Codex keeps in the ChatGPT account from files Codex
  already has here (its state file, HTTP cache and session logs). It never writes them, goes online or uses
  Codex's sign-in. Settings `codexPets` maps each cloud pet to its folder and art, so a pet already here is
  linked rather than copied, and a pulled pet deleted here stays deleted.
- `pets.rs` writes atomically, and the first save of a pet each run backs it up to `.companion-backup/<unix>/`.
  Deleting a pet moves its folder to `<pets>/.companion-trash/<unix ms>-<id>/`, which both apps skip; only the
  Deleted panel's Empty removes anything for good.

## Commands

```bash
cargo test -p claude-companion --lib
```

```bash
python tools/build_installer.py --install
```

```bash
python src-tauri/icons/gen_icons.py
```

- Set `CARGO_TARGET_DIR=C:/ct` on Windows.
- Every build is signed for the updater, so `build_installer.py` reads `~/.tauri/claude-companion.key`.
- The app embeds `ui/` at build time, so reinstall after UI changes.
- Install through `build_installer.py`. It goes through Explorer because shells inside the Claude desktop app
  have their AppData writes redirected.
