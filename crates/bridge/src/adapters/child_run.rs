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
}

impl Drop for ChildRun {
    fn drop(&mut self) {
        // Closing stdin signals EOF; tearing down the process tree + reaping
        // prevents a zombie, and the reader thread ends once stdout closes.
        self.stdin.take();
        kill_process_tree(&mut self.child);
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

        let mut child = command.spawn().map_err(|error| {
            BridgeError::new(
                "backend_unavailable",
                format!("failed to launch backend CLI: {error}"),
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
                Some(status.success())
            }
            _ => None,
        }
    }

    /// Close stdin and kill the whole process tree (the `Drop` impl then reaps and
    /// joins the reader). Used by `stop`.
    pub fn close_and_kill(&mut self) {
        self.stdin.take();
        kill_process_tree(&mut self.child);
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
