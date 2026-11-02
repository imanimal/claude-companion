#!/usr/bin/env python3
"""Build the signed installer and, with --install, install it on this computer.

    python tools/build_installer.py             # Windows: <target>/release/bundle/nsis/Claude Companion_<version>_x64-setup.exe
    python tools/build_installer.py --install   # then install it for this user and start it

Installing puts Claude Companion in %LOCALAPPDATA%\\Claude Companion with a Start menu entry and a desktop shortcut
(no admin prompt). It runs the installer and starts the app through Explorer, as if you'd double-clicked them: a
shell inside a packaged app (Claude's desktop app, for one) has its AppData writes redirected into that package,
which would install a copy only the package can see.

tauri.conf.json turns on updater artifacts, so every build is signed: the key is read from
~/.tauri/claude-companion.key (TAURI_SIGNING_PRIVATE_KEY_PATH points elsewhere). The bundler is the Tauri CLI through
npx, the same CLI the release workflow uses; ui/ itself stays buildless. On macOS this builds the .app and .dmg, and
--install is not supported. Set CARGO_TARGET_DIR to a short folder on Windows (C:/ct) to stay clear of long paths.
"""

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = "Claude Companion"
EXE = "claude-companion.exe"


def main():
    key = Path(os.environ.get("TAURI_SIGNING_PRIVATE_KEY_PATH", Path.home() / ".tauri" / "claude-companion.key"))
    if not key.is_file():
        sys.exit(f"No updater signing key at {key}. Restore your backup, or generate a new pair with\n"
                 f"  npx @tauri-apps/cli@2 signer generate --ci -p \"\" -w {key}\n"
                 "and put the new public key in tauri.conf.json (installed copies then need one manual reinstall).")
    env = dict(os.environ, TAURI_SIGNING_PRIVATE_KEY=key.read_text().strip())
    env.setdefault("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
    win = sys.platform == "win32"
    bundles = "nsis" if win else "app,dmg"
    subprocess.run(["npx", "--yes", "@tauri-apps/cli@2", "build", "--bundles", bundles], cwd=ROOT, env=env, check=True, shell=win)

    target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target"))
    out = target / "release" / "bundle" / ("nsis" if win else "dmg")
    built = sorted(out.glob(f"{NAME}*-setup.exe" if win else "*.dmg"), key=lambda p: p.stat().st_mtime)
    if not built:
        sys.exit(f"Build finished but no installer in {out}")
    setup = built[-1]
    print("Installer:", setup)

    if "--install" in sys.argv:
        if not win:
            sys.exit("--install is Windows only; open the .dmg instead.")
        # Stop every running copy: the new one would hand over to an old one (single instance) instead of starting.
        subprocess.run(["taskkill", "/f", "/im", EXE], capture_output=True)
        log = setup.with_name("install.log")
        log.unlink(missing_ok=True)
        script = setup.with_name("install-and-start.cmd")
        # /S: silent, for this user; silent installs still make the Start menu and desktop shortcuts
        script.write_text(f'@echo off\r\n"{setup}" /S\r\n>"{log}" echo %errorlevel%\r\n'
                          f'start "" "%LOCALAPPDATA%\\{NAME}\\{EXE}"\r\n')
        subprocess.run(["explorer.exe", str(script)])  # returns at once; the script writes the log when done
        for _ in range(240):
            if log.is_file() and log.read_text().strip():
                break
            time.sleep(0.5)
        else:
            sys.exit("The installer didn't finish within two minutes.")
        if log.read_text().strip() != "0":
            sys.exit(f"The installer failed (exit {log.read_text().strip()}).")
        print("Installed and started:", Path(os.environ["LOCALAPPDATA"]) / NAME / EXE)


if __name__ == "__main__":
    main()
