# Claude Companion

A desktop pet for Claude Code that plays Codex pets 1:1. The pet floats on the desktop with a drop shadow, and a
pill above or below it (whichever side has room) shows each Claude session: what it's doing, and a progress bar
from Claude's own estimate. It looks like the Claude desktop app out of the box, and Collegiapp's Pocket design
and plain Standard themes are a click away.

## What it does

- **Codex pets, unchanged.** It comes with no pets of its own: bring a Codex pet (see [First run](#first-run)).
  It reads and writes `~/.codex/pets/<id>/` (`pet.json` plus `spritesheet.png` or
  `.webp`). It handles v1 (1536×1872, 9 rows) and v2 (1536×2288, 11 rows, with 16 look directions) sheets. Frame
  timing and playback match Codex:
  - idle loops slowly;
  - other states play three times, then settle into idle;
  - hovering makes the pet jump, dragging makes it run left or right;
  - v2 pets look toward the cursor.
- **Pets from Codex.** Codex keeps the pets you make with its Pets plugin in your ChatGPT account, not in
  `~/.codex/pets`. The app pulls them into the folder by itself from Codex's own files on this computer (the pet
  list, its image cache and the names in its session logs), with nothing downloaded and no sign-in:
  - a pet already in the folder is matched up instead of copied twice, and gets Codex's art unless its sheet
    is already that art or an edit of it;
  - new art for a pet replaces its sheet, after a backup;
  - a pulled pet you delete stays deleted.
  Settings → Codex has the switch and a "Pull now" button, and each pulled pet's card has "Update from Codex",
  which takes Codex's art again (even over an edit).
- **Out of the way.** On Windows the pet hides while an app is fullscreen on its screen (a video, a game, a
  slideshow) and comes back when it ends. Settings has the switch.
- **Session pills.**
  - States: working (spinner), needs input, ready, blocked.
  - Each pill shows the session title, the latest activity or Claude's last message, the current plan step and a
    percentage.
  - Click the pet to show up to three sessions.
  - Click a pill (or a session in the Claude view) to open that chat in the Claude desktop app. Chats running in
    a terminal open the app instead.
  - Drag the pet anywhere. It glides after the cursor with the pills trailing a little behind, and they settle
    on whichever side has room.
  - Size it from half to twice Codex's size: the slider in Settings, Ctrl+scroll or a pinch over the pet, or Size
    in its right-click menu. Its feet stay where they were.
- **Collegiapp countdowns.** When Collegiapp is on this computer, the pet reads its data
  (`collegiapp.json`) whether or not Collegiapp is open, and shows what's coming up as pills with an LCD clock:
  - a class, office hours, event or ticket from an hour before it starts until it ends;
  - work with a due time (assignments, exams, quizzes, labs) from a day before it's due.
  - Claude chats always come first, so countdowns are in front only while Claude has nothing to show.
  - The clock turns amber 10 minutes before a class or an hour before a deadline, and the pet waves.
  - Click one to open Collegiapp; the x hides it until it moves. Settings has the switch.
- **Delete and restore.** A pet card's trash button moves the pet into `.companion-trash` in the pets folder,
  out of both apps' lists. Undo it from the toast, or restore it later from the Pets view's Deleted panel
  (whose Empty, clicked twice, deletes for good).
- **Spritesheet editor.**
  - Drag frames to reorder them or move them between rows; Shift+drag swaps two frames, Ctrl+drag copies.
  - Flip, nudge, copy and paste (including images from other apps), duplicate and clear frames.
  - Set how many frames each row plays and each frame's duration.
  - Turn on a lean into the drag for pets whose run rows aren't a proper walk cycle; the pet tips toward where
    it's dragged and sways upright when let go.
  - A live preview plays each row like Codex or on a loop.
  - Add or remove the v2 look rows.
  - Everything can be undone. The first save of a pet each run backs up the original into
    `.companion-backup/`.
- **Themes.** Settings has a theme browser in the shared Pocket theme format (Collegiapp's `docs/THEMES.md`), so a
  theme from Collegiapp or PocketCanvas works here too:
  - Claude and Claude Dark (the default: the Claude desktop app's ivory, clay and charcoal, with its serif
    headings), Pocket Cream, Pocket Night, Standard and Standard Dark, as one theme or as a Day and a Night slot
    that switch with the system's dark mode;
  - the pet's pills follow the theme too: the graphite Pocket island in its colours, or flat cards in a Standard theme;
  - import a `.json` file or pasted JSON, export the theme in use, delete imported ones;
  - **Make one with a chatbot**: describe it, open Claude or ChatGPT with the prompt filled in (or copy it), paste
    the reply back, and fix low contrast before saving.
- **Updates.** The app checks GitHub Releases at launch and every 6 hours, and installs a signed update only when you
  say so (the prompt, Settings, or the tray's "Check for updates").
- **Claude Code wiring** (the Claude view, or `claude-companion setup`):
  - async hooks in `~/.claude/settings.json`;
  - a short note in `~/.claude/CLAUDE.md` that asks Claude to send a rough progress estimate with its first tool
    call each turn (`curl -s -m 1 127.0.0.1:47811/p -d p=40 -d "t=Writing the editor"`).

## Install

On Windows, run the `-setup.exe` from the [latest release](https://github.com/imanimal/claude-companion/releases/latest). On a Mac (Apple Silicon or Intel, macOS 11+):

```bash
brew install --cask imanimal/tap/claude-companion
```

On Linux, the `.AppImage` (it updates itself), `.deb` or `.rpm`. Installed copies offer new versions by themselves.

## First run

1. **Add a pet.** The Pets view starts empty, and the desktop shows a paw until you pick one. Drop a Codex pet
   folder, its `pet.json` with the sheet, or just a 1536×1872 or 1536×2288 PNG or WebP sheet on the window, or use
   Import. Pets you already have in Codex show up by themselves: both apps share `~/.codex/pets`, and the ones
   Codex keeps in your ChatGPT account are pulled in (Settings → Codex). The [sources](#pet-sources) below have
   plenty to choose from.
2. **Connect Claude Code.** Open the Claude view and install the hooks and the progress note (or run `setup`,
   below). New Claude Code sessions show up on the pet.
3. **Pick a look.** Settings → Themes, if Claude's own isn't for you.

## Build and install from source

```bash
python tools/build_installer.py --install
```

That builds the NSIS installer with the Tauri CLI (through npx), signed for the updater with
`~/.tauri/claude-companion.key`, and installs it for this user into `%LOCALAPPDATA%\Claude Companion`. On Windows,
set `CARGO_TARGET_DIR` to a short folder (for example `C:/ct`) first. On macOS it builds the `.app` and `.dmg`.

Releases: bump `version` in `src-tauri/tauri.conf.json`, push a `v*` tag, and `.github/workflows/release.yml`
builds Windows, macOS (universal) and Linux installers plus `latest.json` into a draft release. Publishing the
draft ships the update. It needs the `TAURI_SIGNING_PRIVATE_KEY` secret (the key file's contents).

```bash
cargo test -p claude-companion --lib
```

```bash
"%LOCALAPPDATA%\Claude Companion\claude-companion.exe" setup
```

`setup` installs the hooks and the progress note. Add `--remove` to take them out again, or name just `hooks` or
`memory`.

## How it fits together

| Part | What it does |
|---|---|
| `claude-companion hook` | The hook command. It forwards Claude Code's JSON from stdin to `127.0.0.1:47811/hook` and exits at once, so it never blocks Claude. For chats the desktop app started, it also sends the app's chat id (`CLAUDE_CODE_HOST_SESSION_ID`), which is how a click opens `claude://code/continue?session=<id>`. |
| `src-tauri/src/bridge.rs` | The local HTTP bridge: `/hook`, `/p` (progress), `/state` and `/ping`. Requests that carry an `Origin` header are refused, so web pages can't use it. |
| `sessions.rs` | Turns hook events into session states. It reads `update_plan`/`TodoWrite` for the current step and a fallback progress figure, and it reads the transcript tail for titles, Claude's latest text and interrupts. |
| `updater.rs` | Signed self-updates from GitHub Releases' `latest.json`: checks, announces (`update-available`, the tray item) and installs when asked. |
| `ui/js/themes.js` | The shared Pocket theme format: built-ins, import (files, pasted JSON, chatbot replies), contrast checks and fixes, and the mapping onto the window's CSS variables. |
| `collegiapp.rs` | Reads Collegiapp's store every 15 s (parsing it only when it changed) and picks the classes and deadlines worth a pill. It never writes to Collegiapp's files. |
| `codex.rs` | Pulls Codex's cloud pets when its state file changes: the list from `.codex-global-state.json`, the sheets from Codex's HTTP cache (Chromium's blockfile or simple cache) and the names from its session logs. It never writes to Codex's files or goes online. |
| `ui/pet.html` + `ui/js/pet.js` | The transparent, click-through overlay. Rust polls the cursor against the hit areas that the page reports. |
| `ui/index.html` | The library, the editor, the Claude setup view and Settings. |

## Pet sources

[codex-pets](https://github.com/senyo888/codex-pets),
[codex-custom-pets](https://github.com/webkubor/codex-custom-pets) and the
[community thread](https://community.openai.com/t/show-us-your-custom-codex-pet/1387591).
