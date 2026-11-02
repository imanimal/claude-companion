# Claude Companion

A desktop pet for Claude Code that plays Codex pets 1:1. The pet floats on the desktop with a drop shadow, and a
pill above or below it (whichever side has room) shows each Claude session: what it's doing, and a progress bar
from Claude's own estimate. It's styled like Collegiapp's Pocket design.

## What it does

- **Codex pets, unchanged.** Reads and writes `~/.codex/pets/<id>/` (`pet.json` plus `spritesheet.png` or
  `.webp`). It handles v1 (1536×1872, 9 rows) and v2 (1536×2288, 11 rows, with 16 look directions) sheets. Frame
  timing and playback match Codex:
  - idle loops slowly;
  - other states play three times, then settle into idle;
  - hovering makes the pet jump, dragging makes it run left or right;
  - v2 pets look toward the cursor.
- **Session pills.**
  - States: working (spinner), needs input, ready, blocked.
  - Each pill shows the session title, the latest activity or Claude's last message, the current plan step and a
    percentage.
  - Click the pet to show up to three sessions.
  - Click a pill (or a session in the Claude view) to open that chat in the Claude desktop app. Chats running in
    a terminal open the app instead.
  - Drag the pet anywhere; the pills follow it to whichever side has room.
- **Spritesheet editor.**
  - Drag frames to reorder them or move them between rows; Shift+drag swaps two frames, Ctrl+drag copies.
  - Flip, nudge, copy and paste (including images from other apps), duplicate and clear frames.
  - Set how many frames each row plays and each frame's duration.
  - A live preview plays each row like Codex or on a loop.
  - Add or remove the v2 look rows.
  - Everything can be undone. The first save of a pet each run backs up the original into
    `.companion-backup/`.
- **Claude Code wiring** (the Claude view, or `claude-companion setup`):
  - async hooks in `~/.claude/settings.json`;
  - a short note in `~/.claude/CLAUDE.md` that asks Claude to send a rough progress estimate with its first tool
    call each turn (`curl -s -m 1 127.0.0.1:47811/p -d p=40 -d "t=Writing the editor"`).

## Build and install

```bash
python tools/build_installer.py --install
```

That builds the NSIS installer with the Tauri CLI (through npx) and installs it for this user into
`%LOCALAPPDATA%\Claude Companion`. On Windows, set `CARGO_TARGET_DIR` to a short folder (for example `C:/ct`) first.

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
| `ui/pet.html` + `ui/js/pet.js` | The transparent, click-through overlay. Rust polls the cursor against the hit areas that the page reports. |
| `ui/index.html` | The library, the editor, the Claude setup view and Settings. |

Pet sources: [codex-pets](https://github.com/senyo888/codex-pets),
[codex-custom-pets](https://github.com/webkubor/codex-custom-pets) and the
[community thread](https://community.openai.com/t/show-us-your-custom-codex-pet/1387591).
