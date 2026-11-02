// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `claude-companion hook` is the Claude Code hook command: forward stdin and exit, no window, no
    // single-instance handover. A Claude Code that ran the exec-form hook without its args still sets
    // CLAUDE_PROJECT_DIR, so a bare launch from a hook is treated the same way.
    let first = std::env::args().nth(1);
    let from_hook = first.is_none() && std::env::var_os("CLAUDE_PROJECT_DIR").is_some();
    if first.as_deref() == Some("hook") || from_hook {
        claude_companion_lib::hook_client();
        return;
    }
    // `claude-companion setup [hooks] [memory] [--remove]`: the Claude view's setup keys, from a terminal
    if first.as_deref() == Some("setup") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(claude_companion_lib::setup_cli(&args));
    }
    claude_companion_lib::run()
}
