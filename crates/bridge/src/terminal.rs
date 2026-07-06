//! Integrated terminal: a real, PTY-backed interactive shell the operator drives from the
//! cockpit (ADR-0103). This is the sharpest member of the ADR-0103 D9 Supervised Exec
//! Posture, and it is gated as one:
//!
//! - **Host-owned, never backend-streamable.** A session is opened only by the host in
//!   response to an operator action; its control events are host-synthesized and device-
//!   wide, rejected from any backend adapter stream (the host wires that in the bridge).
//! - **Allowlist-anchored opening (D2).** The initial working directory MUST be an
//!   allowlisted workspace root; the host gates that with `workspace_allows` before calling
//!   [`TerminalSession::open`]. The allowlist is the *door*, not a runtime jail: once open,
//!   the shell has the operator's full OS-user reach, exactly as if they opened a native
//!   terminal, and this module claims no containment it cannot deliver (ADR-0090 D4).
//! - **Desktop-local-only by default (D3).** Enforced by the host: a relay session is
//!   refused a terminal; this module never runs for a relay connection.
//! - **Supervised lifecycle (D5).** The shell and its whole descendant tree run so a kill
//!   takes the tree (`taskkill /T` on Windows; the PTY session leads the group on Unix and
//!   dropping the master HUPs stragglers), and the session is killed on close / device
//!   disconnect / token revocation / opening-root removal / idle timeout.
//! - **Envelope-audited only (D6).** The host logs open/close/cwd/device/termination; this
//!   module never persists PTY output to any transcript, cache, or sync surface.
//!
//! The PTY plumbing mirrors [`crate::usage_probe`], which already drives vendor TUIs under a
//! PTY; the difference is that a terminal is long-lived and bidirectionally interactive
//! rather than a one-shot capped capture.

use crate::adapter::BridgeError;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender, TrySendError};

/// One inbound PTY read. 8 KiB matches the usage-probe reader and is a good balance between
/// latency and syscall overhead for an interactive stream.
const PTY_READ_CHUNK: usize = 8192;

/// Depth of the input queue feeding the writer thread. Keystrokes are tiny and the shell
/// normally drains instantly; a bounded queue means that if the shell stops reading its
/// stdin, further input is refused (`terminal_backpressure`) rather than blocking the caller.
const INPUT_QUEUE_DEPTH: usize = 256;

/// Environment override for the shell a terminal launches. Unset defaults to the operator's
/// login shell (`$SHELL` on Unix, `%COMSPEC%` on Windows), then a platform fallback. The
/// shell choice is `[Provisional]` per ADR-0103.
const TERMINAL_SHELL_ENV: &str = "HONEYHUB_TERMINAL_SHELL";

/// Resolve the shell binary to launch: the explicit override, else the operator's login
/// shell, else a platform default. The client never chooses this (ADR-0103 D1: the terminal
/// is host-owned; the operator drives it turn by turn, but does not supply the program).
fn resolve_shell() -> String {
    resolve_shell_with(std::env::var(TERMINAL_SHELL_ENV).ok())
}

/// The override-vs-default decision, split out so it is testable without mutating the process
/// environment (which would race parallel tests).
fn resolve_shell_with(override_shell: Option<String>) -> String {
    if let Some(shell) = override_shell {
        let shell = shell.trim().to_string();
        if !shell.is_empty() {
            return shell;
        }
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

/// A live terminal session: a PTY-attached shell child, the master (held for resize), an input
/// queue to a dedicated writer thread (so a blocked stdin never stalls the caller), a reader
/// thread draining PTY output into a channel, and the bookkeeping to tree-kill exactly once.
/// Owned by the host, one per open session.
pub struct TerminalSession {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    /// Bounded queue to the writer thread. A non-blocking `try_send` keeps `write_input` O(1)
    /// off the host's async lock even when the shell has stopped reading its stdin.
    input_tx: SyncSender<Vec<u8>>,
    process_id: Option<u32>,
    /// Set once the tree has been signalled, so it is signalled exactly once across an
    /// explicit close and `Drop`.
    killed: bool,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        // Kill the shell tree, then let the struct's fields drop. We do NOT join the reader or
        // writer threads here: the reader is blocked in `read()` on a CLONE of the pty master,
        // and on Windows (ConPTY) that read does not unblock until the master handle itself is
        // closed, which only happens as `self.master` drops AFTER this `drop` body returns.
        // Joining here would therefore deadlock. Detaching is safe: once `master` drops and
        // `input_tx` drops (closing the writer thread's channel), the pty closes, both threads
        // return, and their handles are already detached.
        self.kill_tree_once();
    }
}

impl TerminalSession {
    /// Open a PTY-backed shell rooted at `cwd` (which the host has already gated against the
    /// workspace allowlist, ADR-0103 D2), sized `cols` x `rows`. Returns the session plus a
    /// receiver of every output chunk the shell writes; the host pumps that to the owning
    /// device as host-synthesized `terminal_output` events.
    pub fn open(cwd: &str, cols: u16, rows: u16) -> Result<(Self, Receiver<Vec<u8>>), BridgeError> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                BridgeError::new(
                    "terminal_open_failed",
                    format!("could not open a pty: {error}"),
                )
            })?;

        let shell = resolve_shell();
        let mut builder = CommandBuilder::new(&shell);
        builder.cwd(cwd);
        // Audit line (ADR-0103 D6): every terminal open is host-logged with the shell and
        // opening directory, so a session is traceable from the bridge console.
        eprintln!("[terminal] opening '{shell}' in {cwd}");
        let child = pair.slave.spawn_command(builder).map_err(|error| {
            BridgeError::new(
                "terminal_open_failed",
                format!("could not launch the shell '{shell}': {error}"),
            )
        })?;
        drop(pair.slave);
        let process_id = child.process_id();

        let mut reader = pair.master.try_clone_reader().map_err(|error| {
            BridgeError::new(
                "terminal_open_failed",
                format!("could not read the pty: {error}"),
            )
        })?;
        let mut writer = pair.master.take_writer().map_err(|error| {
            BridgeError::new(
                "terminal_open_failed",
                format!("could not write the pty: {error}"),
            )
        })?;

        // Reader thread: forward output chunks to the channel until EOF (shell exit) or the
        // host drops the receiver (session retired). The channel closing is how the host
        // observes the shell's exit. The thread is detached (its handle dropped): on Drop we
        // must not join it (see the Drop impl), and it self-terminates when the pty closes.
        let (sender, receiver) = channel::<Vec<u8>>();
        std::thread::spawn(move || pump_output(&mut reader, &sender));

        // Writer thread: own the pty writer and drain the bounded input queue. Keeping the
        // (potentially blocking) `write_all` off the caller means the host's `write_input`
        // never blocks the async lock when a shell has stopped reading its stdin.
        let (input_tx, input_rx) = sync_channel::<Vec<u8>>(INPUT_QUEUE_DEPTH);
        std::thread::spawn(move || pump_input(&mut writer, &input_rx));

        Ok((
            Self {
                child,
                master: pair.master,
                input_tx,
                process_id,
                killed: false,
            },
            receiver,
        ))
    }

    /// The shell's OS process id, captured at open (`None` if the platform did not report one).
    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    /// Queue operator keystrokes for the shell's stdin. Non-blocking: it hands the bytes to the
    /// writer thread and returns immediately. `terminal_backpressure` if the input queue is full
    /// (the shell has stopped reading its stdin), `terminal_write_failed` if the shell is gone.
    pub fn write_input(&self, data: &[u8]) -> Result<(), BridgeError> {
        self.input_tx
            .try_send(data.to_vec())
            .map_err(|error| match error {
                TrySendError::Full(_) => BridgeError::new(
                    "terminal_backpressure",
                    "the terminal input queue is full; the shell is not reading its stdin",
                ),
                TrySendError::Disconnected(_) => {
                    BridgeError::new("terminal_write_failed", "the terminal is closed")
                }
            })
    }

    /// Resize the PTY so the shell and any TUI reflow. Best-effort: a resize error is not
    /// fatal to the session.
    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    /// Tree-kill the session (once). Idempotent with `Drop`. The host observes shell exit via
    /// the output channel closing (the reader thread reaching PTY EOF), so there is no separate
    /// poll: a session ends either because the shell exited (EOF) or because it was retired.
    pub fn close(&mut self) {
        self.kill_tree_once();
    }

    fn kill_tree_once(&mut self) {
        if self.killed {
            return;
        }
        self.killed = true;
        // Best-effort whole-tree kill (ADR-0103 D5). On Windows `taskkill /T` walks the process
        // tree by pid. On Unix the pty child is a session leader (portable-pty calls `setsid`),
        // so signalling the negative pid takes its whole process group, catching descendants the
        // bare `child.kill()` would miss. Neither reaches a descendant that deliberately detaches
        // into its own session (e.g. `setsid`/`disown`), so the guarantee is best-effort.
        #[cfg(windows)]
        if let Some(pid) = self.process_id {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
        #[cfg(unix)]
        if let Some(pid) = self.process_id {
            // SAFETY: `kill(2)` with a negative pid signals the process group; it has no memory
            // effects and an invalid/exited group is a harmless ESRCH.
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
    }
}

/// Drain PTY output to `sender` until EOF or a hard read error (shell exit), one chunk per read.
/// A signal-interrupted read (`ErrorKind::Interrupted`) is retried rather than treated as exit,
/// so a stray signal to the reader thread does not close a live session.
fn pump_output(reader: &mut (dyn Read + Send), sender: &Sender<Vec<u8>>) {
    let mut buffer = [0_u8; PTY_READ_CHUNK];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return, // EOF: the shell exited
            Ok(n) => {
                if sender.send(buffer[..n].to_vec()).is_err() {
                    return; // the host dropped the receiver (session retired)
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {} // retry
            Err(_) => return,
        }
    }
}

/// Drain the input queue to the pty writer until the queue closes (session retired) or a write
/// error (the shell is gone). Runs on its own thread so a blocked stdin never stalls the caller.
fn pump_input(writer: &mut (dyn Write + Send), input_rx: &Receiver<Vec<u8>>) {
    while let Ok(chunk) = input_rx.recv() {
        if writer
            .write_all(&chunk)
            .and_then(|()| writer.flush())
            .is_err()
        {
            return; // the shell is gone
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_shell_honours_the_override() {
        assert_eq!(
            resolve_shell_with(Some("/custom/shell".to_string())),
            "/custom/shell"
        );
        // A blank override falls through to the platform default / login shell.
        assert!(!resolve_shell_with(Some("   ".to_string())).is_empty());
        // No override resolves to a non-empty platform default / login shell.
        assert!(!resolve_shell_with(None).is_empty());
    }

    /// Open a real PTY running the platform's own shell (no fixture binary), exercise input +
    /// output streaming + a resize, then tree-kill. Asserts the *plumbing* contract that is
    /// deterministic across platforms: the reader thread streams the shell's output over the
    /// channel, a pid is captured, input writes succeed, resize does not panic, and close is
    /// idempotent and does not hang (Drop detaches the reader rather than joining it). The exact
    /// echoed text is shell- and ConPTY-timing-dependent, so matching it is opportunistic.
    #[test]
    fn open_streams_output_and_tree_kills() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let (mut session, output) = TerminalSession::open(&cwd, 80, 24).expect("open a terminal");
        assert!(session.process_id().is_some());
        session.resize(100, 30); // must not panic

        // Ask the (still-running) shell to echo a marker. We do NOT tell it to exit in the same
        // line: tearing the shell down races its output flush under ConPTY. We tree-kill below.
        #[cfg(windows)]
        session.write_input(b"echo hh_marker\r\n").expect("write");
        #[cfg(not(windows))]
        session.write_input(b"echo hh_marker\n").expect("write");

        let mut bytes = 0usize;
        let mut seen = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match output.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(chunk) => {
                    bytes += chunk.len();
                    seen.push_str(&String::from_utf8_lossy(&chunk));
                    if seen.contains("hh_marker") {
                        break; // opportunistic: the shell echoed the marker
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(bytes > 0, "expected the shell to stream some output");

        // Both explicit close and the implicit Drop must be idempotent and must not hang.
        session.close();
        session.close();
    }
}
