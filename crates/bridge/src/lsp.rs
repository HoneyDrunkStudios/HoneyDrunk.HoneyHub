//! LSP proxy: run allowlisted, operator-installed language servers as long-lived,
//! supervised subprocesses and pipe their LSP JSON-RPC (Content-Length framed stdio)
//! over the bridge to a browser language client (ADR-0102).
//!
//! Trust model (mirrors the checks channel): the client never sends a command line. It
//! sends a **language id**; the host resolves that id against its own allowlist table
//! below (rust-analyzer / typescript-language-server / csharp-ls, extensible per row),
//! locates the operator-installed binary on `PATH` (honest "not installed" when absent —
//! the bridge locates, never downloads), and spawns it **shell-free** in its own process
//! group, scoped to an allowlisted workspace root (gated by the host before calling in
//! here, the same `workspace_allows` posture as search/fsbrowse). One server per
//! (language, root) is reused across files. The process tree is killed on stop /
//! session-end / disconnect / root-removal via the same `killpg` / `taskkill` mechanics
//! the run driver uses (reused from [`crate::adapters::child_run`]). A language with no
//! allowlisted or no installed server degrades gracefully: the cockpit keeps its in-file
//! Monaco IntelliSense (ADR-0090 D4), signalled by an honest [`LspStatus`].
//!
//! The module is deliberately a **dumb pipe** — it frames/unframes and supervises, but
//! never interprets the LSP payload. The bytes it carries are whatever the client and
//! server exchange; the bridge only owns *which* server may run and *where*.

use crate::adapter::BridgeError;
use crate::adapters::child_run::{kill_process_tree, put_in_own_process_group};
use crate::backend_catalog::resolve_program;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread::JoinHandle;

/// Cap one inbound LSP message body. rust-analyzer can emit large payloads (semantic
/// tokens, big completion lists); 32 MiB is generous while still bounding a hostile or
/// runaway server. An over-cap frame is drained (to keep the stream framed) but dropped.
const MAX_LSP_MESSAGE_BYTES: usize = 32 * 1024 * 1024;

/// One allowlisted language server: how the host launches it for a language id. The
/// client never sends a command line — it sends a language id, resolved to one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerSpec {
    /// Stable server id (reported to the cockpit; never a client input).
    pub server_id: &'static str,
    /// The program to locate on `PATH` (a bare name; resolved via `PATHEXT` on Windows).
    pub program: &'static str,
    /// Fixed stdio-mode args. Never client-supplied.
    pub args: &'static [&'static str],
    /// Env var overriding the located program path (operator / runner override).
    pub program_env: &'static str,
}

/// The allowlist: Monaco language id -> the server that speaks it. Extending support for a
/// new language is a **row here**, not new plumbing. `javascript` reuses the TypeScript
/// server (it serves both). `--stdio` puts typescript-language-server in stdio mode;
/// rust-analyzer and csharp-ls speak stdio by default.
const SERVERS: &[(&str, ServerSpec)] = &[
    (
        "typescript",
        ServerSpec {
            server_id: "typescript-language-server",
            program: "typescript-language-server",
            args: &["--stdio"],
            program_env: "HONEYHUB_LSP_TYPESCRIPT_PROGRAM",
        },
    ),
    (
        "javascript",
        ServerSpec {
            server_id: "typescript-language-server",
            program: "typescript-language-server",
            args: &["--stdio"],
            program_env: "HONEYHUB_LSP_TYPESCRIPT_PROGRAM",
        },
    ),
    (
        "rust",
        ServerSpec {
            server_id: "rust-analyzer",
            program: "rust-analyzer",
            args: &[],
            program_env: "HONEYHUB_LSP_RUST_PROGRAM",
        },
    ),
    (
        "csharp",
        ServerSpec {
            server_id: "csharp-ls",
            program: "csharp-ls",
            args: &[],
            program_env: "HONEYHUB_LSP_CSHARP_PROGRAM",
        },
    ),
];

/// Resolve a Monaco language id to its allowlisted server spec. `None` = no server is
/// allowlisted for this language (graceful degradation, not an error).
pub fn resolve_server(language_id: &str) -> Option<ServerSpec> {
    SERVERS
        .iter()
        .find(|(id, _)| *id == language_id)
        .map(|(_, spec)| *spec)
}

/// Locate the operator-installed binary for a spec: the env override first (an absolute
/// path is trusted iff it exists; a bare name walks `PATH`), else the default program on
/// `PATH`. `None` = not installed (the honest "no server" signal — the bridge never
/// downloads one).
pub fn locate(spec: &ServerSpec) -> Option<OsString> {
    locate_program(spec.program_env, spec.program)
}

fn locate_program(program_env: &str, default_program: &str) -> Option<OsString> {
    if let Ok(value) = std::env::var(program_env) {
        let value = value.trim().to_string();
        if !value.is_empty() {
            let path = Path::new(&value);
            if path.is_absolute() {
                // An explicit operator path is honoured only if it exists, so an absent
                // override still degrades honestly rather than failing at spawn.
                return path.exists().then(|| OsString::from(&value));
            }
            return resolve_program(&value).map(PathBuf::into_os_string);
        }
    }
    resolve_program(default_program).map(PathBuf::into_os_string)
}

/// A language-server lifecycle / capability signal, carried device-wide to the cockpit.
/// The honest degradation flag (ADR-0090 D4): when `installed` / `running` is false the
/// cockpit keeps its in-file IntelliSense and shows a quiet note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    /// The workspace root the server is (or would be) scoped to.
    pub root: String,
    /// The Monaco language id this status is about.
    pub language_id: String,
    /// The resolved allowlist server id, or empty when no server is allowlisted.
    pub server_id: String,
    /// True when a server binary was located on `PATH` (operator-installed).
    pub installed: bool,
    /// True when a supervised server process is currently running for this key.
    pub running: bool,
    /// A short human-readable reason, for a quiet cockpit note.
    pub reason: String,
}

/// A live language server: its piped stdin (Content-Length framed writes), the reader
/// thread draining framed messages off stdout into a channel, and the bookkeeping to kill
/// the tree exactly once. Owned by the host inside a `Mutex<HashMap<..>>`, one per
/// (language, root).
pub struct LspServer {
    server_id: String,
    child: Child,
    process_id: u32,
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
    /// Set once the process tree has been signalled, so it is signalled exactly once
    /// across `close_and_kill` + `Drop`.
    killed: bool,
}

impl Drop for LspServer {
    fn drop(&mut self) {
        // Close stdin (EOF to the server), kill the whole tree once, and join the reader —
        // so dropping the handle (stop / session-end / disconnect / root-removal) tears the
        // process down deterministically.
        self.stdin.take();
        self.kill_tree_once();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl LspServer {
    /// Spawn the located `program` with `args` in `root`, shell-free and in its own process
    /// group, with piped stdio. Returns the handle plus a receiver of every inbound LSP
    /// message the server frames on stdout (parsed to a JSON value). The caller supervises
    /// the handle and pumps the receiver.
    pub fn spawn(
        program: OsString,
        args: &[&str],
        root: &str,
        server_id: impl Into<String>,
    ) -> Result<(Self, Receiver<Value>), BridgeError> {
        let mut command = Command::new(&program);
        command
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Own process group (unix) so a later kill takes the whole tree; no-op on Windows,
        // where `taskkill /T` walks the tree by pid.
        put_in_own_process_group(&mut command);

        let display = program.to_string_lossy().into_owned();
        let mut child = command.spawn().map_err(|error| {
            BridgeError::new(
                "lsp_spawn_failed",
                format!("failed to launch language server '{display}': {error}"),
            )
        })?;
        let process_id = child.id();
        let stdin = child.stdin.take().ok_or_else(|| {
            BridgeError::new("lsp_spawn_failed", "language server exposed no stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            BridgeError::new("lsp_spawn_failed", "language server exposed no stdout")
        })?;

        // Drain stderr on its own thread so a chatty server cannot fill the stderr pipe and
        // block itself while we read stdout.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut sink = std::io::sink();
                let _ = std::io::copy(&mut reader, &mut sink);
            });
        }

        let (sender, receiver) = channel();
        let reader = std::thread::spawn(move || read_frames(BufReader::new(stdout), &sender));

        Ok((
            Self {
                server_id: server_id.into(),
                child,
                process_id,
                stdin: Some(stdin),
                reader: Some(reader),
                killed: false,
            },
            receiver,
        ))
    }

    /// The allowlist server id this process is running for.
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    /// The OS process id, captured at spawn.
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Frame `message` (Content-Length) and write it to the server's stdin. Errors with
    /// `lsp_not_running` if stdin has been closed, or `lsp_write_failed` on an I/O error.
    pub fn write_message(&mut self, message: &Value) -> Result<(), BridgeError> {
        let stdin = self.stdin.as_mut().ok_or_else(|| {
            BridgeError::new("lsp_not_running", "language server stdin is closed")
        })?;
        let framed = frame_message(message);
        stdin
            .write_all(&framed)
            .and_then(|()| stdin.flush())
            .map_err(|error| {
                BridgeError::new(
                    "lsp_write_failed",
                    format!("failed to write to language server: {error}"),
                )
            })
    }

    /// Observe process exit: `Some(success)` once the child has exited, `None` while it is
    /// still running.
    pub fn poll_exit(&mut self) -> Option<bool> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.success()),
            _ => None,
        }
    }

    /// Close stdin and kill the whole process tree (once). Idempotent with `Drop`.
    pub fn close_and_kill(&mut self) {
        self.stdin.take();
        self.kill_tree_once();
    }

    fn kill_tree_once(&mut self) {
        if !self.killed {
            kill_process_tree(&mut self.child);
            self.killed = true;
        }
    }
}

/// Prefix `message` with an LSP `Content-Length` header framing its UTF-8 JSON body.
fn frame_message(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_else(|_| b"{}".to_vec());
    let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    framed.extend_from_slice(&body);
    framed
}

/// Read Content-Length framed LSP messages off `reader` until EOF (server exit) or a
/// malformed frame, sending each parsed message to `sender`. The reader ending is how the
/// host observes the server's exit (the channel disconnects).
fn read_frames(mut reader: BufReader<ChildStdout>, sender: &Sender<Value>) {
    loop {
        let Some(len) = read_content_length(&mut reader) else {
            return;
        };
        if len == 0 {
            continue;
        }
        if len > MAX_LSP_MESSAGE_BYTES {
            // Keep the stream framed by consuming the oversized body, but drop it.
            if discard_exact(&mut reader, len).is_err() {
                return;
            }
            continue;
        }
        let mut body = vec![0_u8; len];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        // A malformed frame is skipped (the length kept us in sync, so keep reading); a
        // send error means the host dropped the receiver (server retired) — stop reading.
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            if sender.send(value).is_err() {
                return;
            }
        }
    }
}

/// Read LSP headers up to the blank line, returning the `Content-Length`. `None` on EOF or
/// a header block without a length (which ends the reader, so the host observes exit).
fn read_content_length(reader: &mut impl BufRead) -> Option<usize> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return None, // EOF
            Ok(_) => {}
            Err(_) => return None,
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            // Blank line ends the header block; `None` here means no length was seen.
            return content_length;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = rest.trim().parse::<usize>().ok();
        }
        // Other headers (e.g. Content-Type) are ignored.
    }
}

/// Consume exactly `remaining` bytes from `reader`, discarding them (used to skip an
/// over-cap body while keeping the frame stream in sync).
fn discard_exact(reader: &mut impl Read, mut remaining: usize) -> std::io::Result<()> {
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let want = remaining.min(buffer.len());
        let read = reader.read(&mut buffer[..want])?;
        if read == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        remaining -= read;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn resolves_allowlisted_languages_and_denies_others() {
        assert_eq!(
            resolve_server("typescript").map(|s| s.server_id),
            Some("typescript-language-server")
        );
        // JavaScript reuses the TypeScript server.
        assert_eq!(
            resolve_server("javascript").map(|s| s.server_id),
            Some("typescript-language-server")
        );
        assert_eq!(
            resolve_server("rust").map(|s| s.server_id),
            Some("rust-analyzer")
        );
        assert_eq!(
            resolve_server("csharp").map(|s| s.server_id),
            Some("csharp-ls")
        );
        // A language with no allowlisted server, and obvious non-languages, resolve to None.
        assert_eq!(resolve_server("python"), None);
        assert_eq!(resolve_server(""), None);
        assert_eq!(resolve_server("rm -rf /"), None);
    }

    #[test]
    fn locate_reports_honestly_when_a_binary_is_absent() {
        // A bare-name override that resolves nowhere on PATH is "not installed" (None),
        // never a fabricated path — the graceful-degradation signal.
        let var = "HONEYHUB_LSP_TEST_ABSENT_PROGRAM";
        std::env::set_var(var, "definitely-not-a-real-language-server-xyz");
        assert_eq!(locate_program(var, "also-not-real-xyz"), None);
        std::env::remove_var(var);
    }

    #[test]
    fn locate_honours_an_absolute_operator_override_that_exists() {
        // An absolute override is trusted only if it exists on disk.
        let var = "HONEYHUB_LSP_TEST_ABS_PROGRAM";
        let existing = std::env::current_exe().expect("current exe");
        std::env::set_var(var, &existing);
        assert_eq!(
            locate_program(var, "unused-default"),
            Some(existing.into_os_string())
        );
        std::env::set_var(var, "/definitely/not/here/lsp-xyz");
        assert_eq!(locate_program(var, "also-not-real-xyz"), None);
        std::env::remove_var(var);
    }

    #[test]
    fn frames_a_message_with_a_byte_accurate_content_length() {
        let framed = frame_message(&serde_json::json!({"jsonrpc": "2.0", "id": 1}));
        let text = String::from_utf8(framed).expect("utf8");
        let (header, body) = text.split_once("\r\n\r\n").expect("header/body split");
        assert_eq!(header, format!("Content-Length: {}", body.len()));
        assert!(body.contains("\"jsonrpc\":\"2.0\""));
    }

    #[test]
    fn reads_content_length_and_ignores_other_headers() {
        let raw = "Content-Type: application/vscode-jsonrpc\r\nContent-Length: 42\r\n\r\n";
        assert_eq!(read_content_length(&mut Cursor::new(raw)), Some(42));
        // A header block with no length ends the reader.
        assert_eq!(read_content_length(&mut Cursor::new("\r\n")), None);
        // EOF mid-stream ends the reader.
        assert_eq!(read_content_length(&mut Cursor::new("")), None);
    }

    /// A trivial, immediately-exiting command on each platform — enough to exercise
    /// spawn + the kill/reap path without a real language server (the framed round-trip
    /// is covered by the `fake_lsp` integration test).
    fn quick_command() -> (OsString, Vec<&'static str>) {
        #[cfg(windows)]
        {
            (OsString::from("cmd"), vec!["/C", "exit", "0"])
        }
        #[cfg(not(windows))]
        {
            (OsString::from("true"), Vec::new())
        }
    }

    #[test]
    fn spawn_kill_lifecycle_is_idempotent() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let (program, args) = quick_command();
        let (mut server, _inbound) =
            LspServer::spawn(program, &args, &root, "quick").expect("spawn quick command");
        assert!(server.process_id() > 0);
        assert_eq!(server.server_id(), "quick");
        // Both explicit kills and the implicit Drop must not double-signal a reaped pid.
        server.close_and_kill();
        server.close_and_kill();
        // Dropping at end of scope is the third potential kill — must be a no-op.
    }
}
