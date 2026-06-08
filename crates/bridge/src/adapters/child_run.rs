//! Shared child-process plumbing for the CLI-driving adapters.
//!
//! Every vendor adapter (`claude.local`, `codex.local`, `copilot.local`) shells
//! out to an official CLI under the user's own local session (ADR-0090 D2/D10) and
//! differs only in four things: the command it builds, the capability flags it
//! declares, how it delivers a reply (same-process stdin vs. a resume/follow-up
//! run), and how it parses the CLI's JSONL into [`crate::wire::BridgeEvent`]s. The *mechanics* —
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
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

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
    /// Set once the process tree has been signalled (by `close_and_kill` or `Drop`).
    /// Guards against a *second* signal — re-killing could hit a recycled pid/group —
    /// while still guaranteeing the tree is killed exactly once before the reader is
    /// joined.
    killed: bool,
}

impl Drop for ChildRun {
    fn drop(&mut self) {
        // Closing stdin signals EOF on the child's input. Then kill the process tree
        // once: this is what makes the reader-thread join below *bounded* — even if
        // the direct CLI has already exited, a descendant that inherited stdout could
        // still hold the pipe open and leave the reader blocked on `read` forever;
        // killing the group forces stdout to EOF so the reader ends. `kill_tree_once`
        // is idempotent, so a prior `close_and_kill` is not double-signalled.
        self.stdin.take();
        self.kill_tree_once();
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
            killed: false,
        })
    }

    /// Kill the process tree exactly once (idempotent). Forces any stdout the child
    /// or its descendants hold open to close, so the reader thread reaches EOF and a
    /// later `join` is bounded.
    fn kill_tree_once(&mut self) {
        if !self.killed {
            kill_process_tree(&mut self.child);
            self.killed = true;
        }
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

    /// Drain the *final* stdout lines after the process has exited, blocking until the
    /// reader thread finishes (channel disconnects) so nothing the child flushed on its
    /// way out is lost — e.g. the closing `result`/usage line a backend emits last.
    /// Bounded by `timeout` (via `recv_timeout`, a timeout-aware receive, not a fixed
    /// sleep) so a child that wrongly keeps stdout open cannot block the caller forever.
    /// Call only after [`poll_exit`](Self::poll_exit) has observed exit.
    pub fn drain_remaining(&mut self, timeout: Duration) -> Vec<String> {
        let deadline = Instant::now() + timeout;
        let mut lines = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.lines.recv_timeout(remaining) {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => lines.push(line),
                // Disconnected = the reader finished (all stdout consumed); Timeout =
                // bounded give-up. Either way, stop.
                Err(RecvTimeoutError::Disconnected) | Err(RecvTimeoutError::Timeout) => break,
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
                // Note: observing the *direct* child's exit does not mark the tree as
                // killed — a descendant could still hold stdout open, so `Drop` still
                // kills the group once to guarantee the reader reaches EOF.
                Some(status.success())
            }
            _ => None,
        }
    }

    /// Close stdin and kill the whole process tree (once). Idempotent — a subsequent
    /// `Drop` will not re-signal. Used by `stop`.
    pub fn close_and_kill(&mut self) {
        self.stdin.take();
        self.kill_tree_once();
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

    /// Retire a live run to a `Done` record, **returning** the displaced live run so
    /// the caller can drop it (which kills the tree and joins the stdout reader
    /// thread) *after* releasing the runs lock. `ChildRun::drop` joins the reader, so
    /// dropping it under the lock could block every other run's `stream`/`reply`/`stop`
    /// if the reader is slow to end — keep that join off the lock. Returns `None` if
    /// the slot was already retired.
    #[must_use = "drop the returned ChildRun after releasing the runs lock"]
    pub fn retire(&mut self) -> Option<Box<ChildRun>> {
        match self {
            RunSlot::Live(run) => {
                let backend_session_id = run.backend_session_id.clone();
                match std::mem::replace(self, RunSlot::Done { backend_session_id }) {
                    RunSlot::Live(run) => Some(run),
                    // `self` was `Live` in the outer match, so the replaced value is
                    // always `Live`; this arm is unreachable.
                    RunSlot::Done { .. } => None,
                }
            }
            RunSlot::Done { .. } => None,
        }
    }

    /// Record a vendor session id discovered *after* retirement — e.g. parsed from a
    /// final line drained off-lock once the run was already a `Done` husk — so a
    /// later follow-up resume sees it. Only updates a retired slot, and only when a
    /// non-`None` id is supplied (never clobbers a known id with `None`).
    pub fn set_done_backend_session_id(&mut self, id: Option<String>) {
        if let (RunSlot::Done { backend_session_id }, Some(id)) = (&mut *self, id) {
            *backend_session_id = Some(id);
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
    use std::time::{Duration, Instant};

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
    fn done_slot_accepts_a_session_id_discovered_after_retirement() {
        // A vendor session id that only appears in a line drained off-lock (after the
        // run was retired to `Done`) must still reach the slot so a follow-up resume
        // sees it.
        let mut slot = RunSlot::Done {
            backend_session_id: None,
        };
        slot.set_done_backend_session_id(Some("vendor-tail".to_string()));
        assert_eq!(slot.backend_session_id(), Some("vendor-tail"));
        // Never clobbers a known id with None.
        slot.set_done_backend_session_id(None);
        assert_eq!(slot.backend_session_id(), Some("vendor-tail"));
    }

    #[test]
    fn retiring_a_run_drops_the_child_but_keeps_the_session_id() {
        let run = ChildRun::spawn(quick_command(), "session-1", Some("vendor-7".to_string()))
            .expect("spawn quick command");
        let mut slot = RunSlot::live(run);
        assert!(slot.as_live_mut().is_some());

        let retired = slot.retire();
        assert!(
            retired.is_some(),
            "retire returns the displaced live run to drop off-lock"
        );
        assert!(
            slot.as_live_mut().is_none(),
            "retired run is no longer live"
        );
        assert_eq!(slot.backend_session_id(), Some("vendor-7"));

        // Retire is idempotent and returns None once already retired.
        assert!(slot.retire().is_none());
        assert_eq!(slot.backend_session_id(), Some("vendor-7"));
    }

    #[test]
    fn close_and_kill_is_idempotent_and_drop_does_not_double_kill() {
        let mut run =
            ChildRun::spawn(quick_command(), "session-1", None).expect("spawn quick command");
        // Poll with an explicit time deadline (not a fixed sleep, not an unbounded
        // iteration count) so the quick process may be observed/reaped via `poll_exit`
        // before the kills below. The test does not depend on observing the exit; the
        // point is that repeated kills are safe whether or not the child was reaped.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if run.poll_exit().is_some() {
                break;
            }
            std::thread::yield_now();
        }
        // Both of these, plus the implicit Drop, must not re-signal a reaped pid.
        run.close_and_kill();
        run.close_and_kill();
        // Dropping at end of scope is the third potential kill — must be a no-op.
    }
}
