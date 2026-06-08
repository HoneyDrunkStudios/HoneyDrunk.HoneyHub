//! Shared child-process plumbing for the CLI-driving adapters.
//!
//! Every vendor adapter (`claude.local`, `codex.local`, `copilot.local`) shells
//! out to an official CLI under the user's own local session (ADR-0090 D2/D10) and
//! differs only in four things: the command it builds, the capability flags it
//! declares, how it delivers a reply (same-process stdin vs. a resume/follow-up
//! run), and how it parses the CLI's JSONL into [`BridgeEvent`]s. The *mechanics* —
//! spawning with piped stdio, draining stderr so it cannot deadlock, reading stdout
//! lines on a background thread, killing the whole process tree, reaping the child,
//! and detecting the one-time process exit — are identical, so they live here once.
//!
//! The crate stays clock-free (timestamps come from the caller everywhere else), so
//! the adapters take an injected [`EventClock`] for stamping the events they mint as
//! a process streams. [`default_event_clock`] is the production convenience; tests
//! inject a deterministic clock.

use crate::adapter::BridgeError;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;

/// A timestamp source for events an adapter mints while streaming. Injected so the
/// bridge crate stays free of a wall-clock dependency and tests stay deterministic.
pub type EventClock = Arc<dyn Fn() -> String + Send + Sync>;

/// A production clock that emits RFC3339 UTC timestamps (e.g.
/// `2026-06-07T12:00:00.000Z`) via the shared [`crate::clock`] helper, so
/// adapter-minted events sort correctly against caller-supplied timestamps during
/// reconnect replay. A host may still inject its own clock.
pub fn default_event_clock() -> EventClock {
    Arc::new(crate::clock::now_rfc3339)
}

/// A live CLI child process: its piped stdin (kept open for same-process reply),
/// a channel fed by the stdout reader thread, and the bookkeeping a vendor adapter
/// needs (the backend's own session id, and whether the terminal exit transition
/// has already been emitted). Owned by an adapter inside a `Mutex<HashMap<..>>`.
pub struct ChildRun {
    /// The HoneyHub session this run belongs to (stamped onto minted events).
    pub session_id: String,
    child: Child,
    process_id: u32,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    reader: Option<JoinHandle<()>>,
    /// The backend's own session id, captured from the CLI's events so a later
    /// `resume` can re-attach to the same vendor session.
    pub backend_session_id: Option<String>,
    /// Set once the process exit has been observed and its terminal status events
    /// emitted, so a later poll does not emit them again.
    finished: bool,
    /// Set once the child has been reaped — either by an observed exit (`poll_exit`)
    /// or an explicit `close_and_kill`. Guards against a second kill: re-signalling a
    /// reaped pid risks hitting a recycled process (group), so `Drop` skips the kill
    /// when the child is already reaped.
    reaped: bool,
}

impl Drop for ChildRun {
    fn drop(&mut self) {
        // Closing stdin signals EOF; tearing down the process tree + reaping
        // prevents a zombie, and the reader thread ends once stdout closes. Only
        // kill if the child has not already been reaped (see `reaped`) — a double
        // kill could signal a recycled pid.
        self.stdin.take();
        if !self.reaped {
            kill_process_tree(&mut self.child);
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl ChildRun {
    /// Spawn `command` with piped stdio and start draining its streams. `session_id`
    /// is the HoneyHub session; `backend_session_id` seeds the vendor session id
    /// (set on `resume`, `None` on a fresh `start`).
    pub fn spawn(
        mut command: Command,
        session_id: impl Into<String>,
        backend_session_id: Option<String>,
    ) -> Result<Self, BridgeError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Put the child in its own process group so `stop` can signal the whole
        // tree (a CLI may spawn tool/MCP subprocesses), matching the Windows
        // `taskkill /T` behaviour.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: `setpgid(0, 0)` runs in the forked child before exec; it only
            // sets the child's process group and is async-signal-safe.
            unsafe {
                command.pre_exec(|| {
                    if libc::setpgid(0, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        // Capture the program name before spawning so a launch failure names the
        // exact CLI (actionable when several local adapters coexist).
        let program = command.get_program().to_string_lossy().into_owned();
        let mut child = command.spawn().map_err(|error| {
            BridgeError::new(
                "backend_unavailable",
                format!("failed to launch backend CLI '{program}': {error}"),
            )
        })?;
        let process_id = child.id();
        let stdin = child.stdin.take().ok_or_else(|| {
            BridgeError::new("backend_unavailable", "backend CLI exposed no stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            BridgeError::new("backend_unavailable", "backend CLI exposed no stdout")
        })?;

        // Drain stderr on its own thread so a chatty CLI cannot fill the stderr
        // pipe buffer and block the child while we are reading stdout.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut sink = std::io::sink();
                let _ = std::io::copy(&mut reader, &mut sink);
            });
        }

        let (sender, receiver) = channel();
        let reader = std::thread::spawn(move || {
            let buffered = BufReader::new(stdout);
            for line in buffered.lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            session_id: session_id.into(),
            child,
            process_id,
            stdin: Some(stdin),
            lines: receiver,
            reader: Some(reader),
            backend_session_id,
            finished: false,
            reaped: false,
        })
    }

    /// The OS process id, captured at spawn so it survives `try_wait`/reaping.
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Write one already-serialized line to the child's stdin (appending the
    /// newline + flush). Used by backends that support same-process live reply.
    /// Errors with `reply_unavailable` if stdin has been closed.
    pub fn write_stdin_line(&mut self, line: &str) -> Result<(), BridgeError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| BridgeError::new("reply_unavailable", "agent stdin is closed"))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|error| {
                BridgeError::new(
                    "io_error",
                    format!("failed to write to agent stdin: {error}"),
                )
            })
    }

    /// Drain every stdout line available right now (non-blocking), skipping blanks.
    /// Returns once the channel is empty or the reader thread has ended.
    pub fn drain_lines(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        loop {
            match self.lines.try_recv() {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => lines.push(line),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        lines
    }

    /// Observe process exit exactly once. Returns `Some(true)` on the first poll
    /// after a successful exit, `Some(false)` after a failing exit, and `None`
    /// while the process is still running or once a prior poll already reported it.
    pub fn poll_exit(&mut self) -> Option<bool> {
        if self.finished {
            return None;
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.finished = true;
                // `try_wait` reaped the child; mark it so `Drop` does not re-signal a
                // potentially recycled pid.
                self.reaped = true;
                Some(status.success())
            }
            _ => None,
        }
    }

    /// Close stdin and kill the whole process tree, reaping the child. Idempotent:
    /// once reaped, it does nothing (and `Drop` likewise skips the kill). Used by
    /// `stop`.
    pub fn close_and_kill(&mut self) {
        self.stdin.take();
        if !self.reaped {
            kill_process_tree(&mut self.child);
            self.reaped = true;
        }
    }
}

/// A run's slot in an adapter's run table: either the live child process, or a
/// lightweight record left after the process has exited. Retiring a completed run to
/// [`RunSlot::Done`] drops the child's handle, reader thread, and channel (freeing
/// them in a long-lived host) while keeping the captured vendor `backend_session_id`
/// so a follow-up turn can still resume the session.
pub enum RunSlot {
    // Boxed so the large live variant does not inflate every map entry (the `Done`
    // husk is tiny).
    Live(Box<ChildRun>),
    Done { backend_session_id: Option<String> },
}

impl RunSlot {
    /// Wrap a freshly spawned live run.
    pub fn live(run: ChildRun) -> Self {
        RunSlot::Live(Box::new(run))
    }

    /// The captured vendor session id, available in both the live and retired states.
    pub fn backend_session_id(&self) -> Option<&str> {
        match self {
            RunSlot::Live(run) => run.backend_session_id.as_deref(),
            RunSlot::Done { backend_session_id } => backend_session_id.as_deref(),
        }
    }

    /// The live child, if this slot has not yet been retired.
    pub fn as_live_mut(&mut self) -> Option<&mut ChildRun> {
        match self {
            RunSlot::Live(run) => Some(run),
            RunSlot::Done { .. } => None,
        }
    }

    /// Retire a live run to a `Done` record, dropping the heavy child resources while
    /// keeping the vendor session id. No-op if already retired.
    pub fn retire(&mut self) {
        if let RunSlot::Live(run) = self {
            *self = RunSlot::Done {
                backend_session_id: run.backend_session_id.clone(),
            };
        }
    }
}

#[cfg(windows)]
fn kill_process_tree(child: &mut Child) {
    // `Child::kill` only kills the immediate process on Windows; `taskkill /T`
    // takes the whole tree the CLI may have spawned. Both are best-effort: an
    // already-exited process simply returns an error we ignore.
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .output();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn kill_process_tree(child: &mut Child) {
    // The child leads its own process group (set via `pre_exec`), so signalling
    // the group id (equal to the child pid) tears down the whole tree rather than
    // just the direct child. Best-effort: an already-dead group yields ESRCH.
    let pid = child.id() as libc::pid_t;
    // SAFETY: `killpg` only sends a signal to a process group; it touches no memory.
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(any(windows, unix)))]
fn kill_process_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A trivial, immediately-exiting command available on each platform.
    fn quick_command() -> Command {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        }
        #[cfg(not(windows))]
        {
            Command::new("true")
        }
    }

    #[test]
    fn done_slot_exposes_backend_session_id_without_a_child() {
        let slot = RunSlot::Done {
            backend_session_id: Some("vendor-1".to_string()),
        };
        assert_eq!(slot.backend_session_id(), Some("vendor-1"));
    }

    #[test]
    fn retiring_a_run_drops_the_child_but_keeps_the_session_id() {
        let run = ChildRun::spawn(quick_command(), "session-1", Some("vendor-7".to_string()))
            .expect("spawn quick command");
        let mut slot = RunSlot::live(run);
        assert!(slot.as_live_mut().is_some());

        slot.retire();
        assert!(
            slot.as_live_mut().is_none(),
            "retired run is no longer live"
        );
        assert_eq!(slot.backend_session_id(), Some("vendor-7"));

        // Retire is idempotent.
        slot.retire();
        assert_eq!(slot.backend_session_id(), Some("vendor-7"));
    }

    #[test]
    fn close_and_kill_is_idempotent_and_drop_does_not_double_kill() {
        let mut run =
            ChildRun::spawn(quick_command(), "session-1", None).expect("spawn quick command");
        // Let it exit on its own first, so the pid may be reaped here.
        std::thread::sleep(Duration::from_millis(50));
        let _ = run.poll_exit();
        // Both of these, plus the implicit Drop, must not re-signal a reaped pid.
        run.close_and_kill();
        run.close_and_kill();
        // Dropping at end of scope is the third potential kill — must be a no-op.
    }
}
