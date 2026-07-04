//! Test fixture: a miniature "vendor TUI" for exercising the usage probe's full
//! PTY loop in CI (the real CLIs only run in the `#[ignore]`d live test). Behaves
//! like the observed vendors: queries the terminal (DSR 6) and waits on the reply,
//! paints a banner, waits for a typed command ending in Enter, then renders a
//! usage panel. `trust` mode paints Claude Code's folder-trust prompt instead and
//! waits forever — the probe must abort without ever typing into it.
//!
//! Feature-gated (`test-fixtures`) so it is never built into a product binary
//! (Grid invariant 16).

use std::io::{Read, Write};

fn main() {
    // Mode comes via env (the probe spawns a bare program, no args; the PTY child
    // inherits the test's environment).
    let mode = std::env::var("FAKE_USAGE_TUI_MODE")
        .ok()
        .or_else(|| std::env::args().nth(1))
        .unwrap_or_default();
    let mut stdout = std::io::stdout();

    if mode == "trust" {
        let _ = write!(
            stdout,
            "Quick safety check: Is this a project you created or one you trust?\r\n\
             1. Yes, I trust this folder 2. No, exit\r\n"
        );
        let _ = stdout.flush();
        // Wait like the real dialog does. If the probe (wrongly) types anything,
        // reveal it in the output so the test would catch the regression.
        let mut stdin = std::io::stdin();
        let mut buffer = [0u8; 64];
        while let Ok(count) = stdin.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let _ = write!(stdout, "TYPED-INTO-TRUST-PROMPT\r\n");
            let _ = stdout.flush();
        }
        return;
    }

    // Query the terminal like the real CLIs do (the probe must answer or a real
    // TUI would block), then paint a boot banner.
    let _ = write!(stdout, "\x1b[6nBooting fake TUI\r\n");
    let _ = stdout.flush();

    // Wait for the typed slash command (ends with Enter).
    let mut stdin = std::io::stdin();
    let mut buffer = [0u8; 1];
    let mut typed = Vec::new();
    while stdin.read(&mut buffer).is_ok() {
        if buffer[0] == b'\r' || buffer[0] == b'\n' {
            break;
        }
        typed.push(buffer[0]);
        if typed.len() > 256 {
            break;
        }
    }

    // Render a vendor-shaped usage panel (meter-bar glyphs included, like Claude).
    let _ = write!(
        stdout,
        "Current session\x1b[33m█████ 34%used\x1b[0mResets 3pm\r\n\
         Current week (all models) ██ 61% used · Resets Jul 7\r\n\
         5h limit: [   ] 95% left (resets 12:42)\r\n"
    );
    let _ = stdout.flush();
    // Linger so the capture settles on its own clock, then exit.
    std::thread::sleep(std::time::Duration::from_secs(20));
}
