# Claude Companion: notes for Claude

A Tauri 2 desktop pet that plays Codex pets 1:1 and shows Claude Code sessions in pills. See `README.md`.

## Invariants

- **Codex fidelity.** `ui/js/sprite.js` is the Codex sprite engine. Its header documents the formats, rows, timing,
  playback and look directions. Don't change Codex behaviour there. Companion-only extras live in pet.json under
  `rowFrames` and `claudeCompanion.timing`, and saving keeps every other key.
- **Buildless UI.** `ui/` is plain classic scripts on `window.CC`, with no bundler and no npm.
  - Main window: `ui.js → sprite.js → editor.js → app.js`, CSS `pocket.css → app.css`.
  - Pet window: `ui.js → sprite.js → pet.js`, CSS `pet.css`.
- **Pocket design** from Collegiapp (P9 Cream / P11 Night tokens, B8 keys, F3 bands, LCD inlays, 9×9 icons in
  `ui.js` PIX). Write UI strings in sentence case.
- **Hooks never hurt Claude.** Hooks are async and run in exec form (`<exe> hook`). The hook client always exits
  0 and gives up after 400 ms. The bridge binds 127.0.0.1 only and refuses requests with an `Origin` header.
- **Windows.** Only `main` is created from the config. `pet` is `"create": false` and is built in `setup` after
  the state is managed. Its click-through comes from Rust polling the cursor against the rects the page reports
  (`set_hit_rects`).
- `pets.rs` writes atomically, and the first save of a pet each run backs it up to `.companion-backup/<unix>/`.

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
- The app embeds `ui/` at build time, so reinstall after UI changes.
- Install through `build_installer.py`. It goes through Explorer because shells inside the Claude desktop app
  have their AppData writes redirected.
