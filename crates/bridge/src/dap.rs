//! Debug Adapter Protocol (DAP) foundations for the HoneyHub bridge (ADR-0106 Slice A).
//!
//! DAP is to debugging what LSP is to IntelliSense: a long-lived, bidirectional JSON-RPC
//! session (Content-Length framed over stdio, identical framing to LSP) between a generic
//! debug UI and a host-selected debugger binary (`netcoredbg` for C#, and later `js-debug`
//! / `codelldb`). This module is the ADR-0106 D2 *host-owned adapter selection* gate plus
//! the DAP wire framing; the supervised adapter subprocess, the debuggee launch through the
//! ADR-0104 substrate, and the two-process lifecycle are wired on top of it.
//!
//! The security-load-bearing property proven here is D2: **the client never sends a command
//! line.** It sends a named adapter id; the host resolves that id against its own built-in
//! allowlist table (the DAP analogue of the ADR-0096 check table and the ADR-0102 server
//! table), locates the operator-installed binary on `PATH`, and would spawn it shell-free.
//! An unknown id resolves to `None` and is refused, never executed.

use crate::adapter::BridgeError;
use crate::adapters::child_run::{kill_process_tree, put_in_own_process_group};
use crate::backend_catalog::resolve_program;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::thread::JoinHandle;

/// One allowlisted debug adapter: how the host launches it. The client never sends a command
/// line (ADR-0106 D2): it sends an `adapter_id`, resolved to one of these rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdapterSpec {
    /// Stable adapter id (reported to the cockpit and sent BY the cockpit to select an
    /// adapter; matched against the table, never used as a command line).
    pub adapter_id: &'static str,
    /// The program to locate on `PATH` (a bare name; resolved via `PATHEXT` on Windows).
    /// Never client-supplied.
    pub program: &'static str,
    /// Fixed args putting the adapter in DAP-over-stdio mode. Never client-supplied.
    pub args: &'static [&'static str],
    /// Env var overriding the located program path (operator-owned override, the
    /// `HONEYHUB_EXTRA_CHECKS` / ADR-0102 D-E spirit: the operator owns the host).
    pub program_env: &'static str,
}

/// The allowlist: adapter id -> how to launch it. Adding an adapter is a **row here**, not
/// new plumbing (ADR-0106 D2). `netcoredbg` (MIT) is the C# default: `--interpreter=vscode`
/// puts it in DAP-over-stdio mode. `js-debug` and `codelldb` are Slice C rows.
const ADAPTERS: &[AdapterSpec] = &[AdapterSpec {
    adapter_id: "netcoredbg",
    program: "netcoredbg",
    args: &["--interpreter=vscode"],
    program_env: "HONEYHUB_DAP_NETCOREDBG_PROGRAM",
}];

/// The detection map: a repo/language id -> the adapter id that debugs it, for the ADR-0106
/// D8 honest capability flag (the cockpit offers Debug only when a resolvable adapter exists
/// for the detected repo type, and Run otherwise). This does not itself launch anything; it
/// answers "which adapter, if any, would debug this language". `csharp` -> `netcoredbg`.
const ADAPTER_FOR_LANGUAGE: &[(&str, &str)] = &[("csharp", "netcoredbg")];

/// Resolve a client-sent adapter id to its allowlisted spec. `None` = the id is not on the
/// allowlist and MUST be refused (ADR-0106 D2 deny-unknown), never spawned.
pub fn resolve_adapter(adapter_id: &str) -> Option<AdapterSpec> {
    ADAPTERS
        .iter()
        .find(|spec| spec.adapter_id == adapter_id)
        .copied()
}

/// The adapter id that debugs `language_id`, if any (ADR-0106 D8 detection). `None` = no
/// adapter is allowlisted for this language, so Debug is honestly unavailable (Run remains).
pub fn adapter_for_language(language_id: &str) -> Option<&'static str> {
    ADAPTER_FOR_LANGUAGE
        .iter()
        .find(|(lang, _)| *lang == language_id)
        .map(|(_, adapter_id)| *adapter_id)
}

/// Locate the operator-installed binary for a spec: the env override first (an absolute path
/// is trusted iff it exists; a bare name walks `PATH`), else the default program on `PATH`.
/// `None` = not installed (the honest "no adapter" signal, ADR-0106 D8 / D9; the bridge
/// never downloads one).
pub fn locate(spec: &AdapterSpec) -> Option<OsString> {
    if let Ok(value) = std::env::var(spec.program_env) {
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
    resolve_program(spec.program).map(PathBuf::into_os_string)
}

/// A debug-adapter lifecycle / capability signal, carried device-wide to the cockpit. The
/// honest degradation flag (ADR-0090 D4 / ADR-0106 D8): when `installed` is false the cockpit
/// offers Run-only (ADR-0104) for this language and shows a quiet note, never an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapStatus {
    /// The language id this status is about (e.g. `csharp`).
    pub language_id: String,
    /// The resolved allowlist adapter id, or empty when none is allowlisted for the language.
    pub adapter_id: String,
    /// True when an adapter binary was located on `PATH` (operator-installed).
    pub installed: bool,
    /// A short human-readable reason, for a quiet cockpit note.
    pub reason: String,
}

/// The honest capability flag for a language (ADR-0106 D8): whether Debug can be offered.
/// Debug is available only when the language maps to an allowlisted adapter AND that adapter
/// binary is located on the operator's `PATH`; otherwise the cockpit shows Run-only.
pub fn dap_status(language_id: &str) -> DapStatus {
    match adapter_for_language(language_id).and_then(resolve_adapter) {
        Some(spec) => {
            let installed = locate(&spec).is_some();
            DapStatus {
                language_id: language_id.to_string(),
                adapter_id: spec.adapter_id.to_string(),
                installed,
                reason: if installed {
                    format!("{} is installed", spec.adapter_id)
                } else {
                    format!(
                        "{} is not installed; Run is still available",
                        spec.adapter_id
                    )
                },
            }
        }
        None => DapStatus {
            language_id: language_id.to_string(),
            adapter_id: String::new(),
            installed: false,
            reason: "no debug adapter for this language; Run is still available".to_string(),
        },
    }
}

/// Upper bound on a single inbound DAP message body, so a hostile or wedged adapter cannot
/// force an unbounded allocation. DAP messages (stack traces, variable trees) are far below
/// this; an over-cap body is consumed to stay framed, then dropped.
pub const MAX_DAP_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Prefix `message` with a DAP `Content-Length` header framing its UTF-8 JSON body. DAP uses
/// the same framing as LSP (`Content-Length: N\r\n\r\n<json>`), so this mirrors the ADR-0102
/// runner exactly (ADR-0106 D2 reuses the ADR-0102 shape wholesale).
pub fn frame_message(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_else(|_| b"{}".to_vec());
    let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    framed.extend_from_slice(&body);
    framed
}

/// Read DAP headers up to the blank line, returning the `Content-Length`. `None` on EOF or a
/// header block without a length (which ends the reader, so the host observes adapter exit).
pub fn read_content_length(reader: &mut impl BufRead) -> Option<usize> {
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

/// Consume exactly `remaining` bytes from `reader`, discarding them (used to skip an over-cap
/// body while keeping the frame stream in sync).
pub fn discard_exact(reader: &mut impl Read, mut remaining: usize) -> std::io::Result<()> {
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

/// Read Content-Length framed DAP messages off `reader` until EOF (adapter exit) or a
/// malformed frame, sending each parsed message to `sender`. The reader ending is how the
/// host observes the adapter's exit (the channel disconnects). Mirrors the ADR-0102 LSP
/// reader; an over-cap body is drained to stay framed, then dropped. `sender` is a BOUNDED
/// `SyncSender`, so a slow / wedged host pump backpressures this reader (and thus the adapter's
/// stdout) instead of letting a chatty debuggee grow bridge memory without limit.
fn read_frames(mut reader: BufReader<ChildStdout>, sender: &SyncSender<Value>) {
    loop {
        let Some(len) = read_content_length(&mut reader) else {
            return;
        };
        if len == 0 {
            continue;
        }
        if len > MAX_DAP_MESSAGE_BYTES {
            if discard_exact(&mut reader, len).is_err() {
                return;
            }
            continue;
        }
        let mut body = vec![0_u8; len];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            if sender.send(value).is_err() {
                return;
            }
        }
    }
}

/// Bound on queued-but-unwritten outbound DAP frames per adapter. Writes happen on a
/// dedicated writer thread so a slow or wedged adapter can never block the host (which would
/// otherwise stall while holding its session map lock); the bound keeps a wedged adapter from
/// accumulating frames without limit. Interactive stepping sits far below this.
const MAX_QUEUED_OUTBOUND_FRAMES: usize = 256;

/// Bound on the inbound (adapter-stdout -> host-pump) frame queue. A BOUNDED channel keeps a
/// chatty debuggee from growing bridge memory without limit when the owning cockpit is slow: a
/// full queue blocks the reader thread, backpressuring the adapter's stdout (the same shape as
/// the outbound queue and the terminal / launch output queues).
const MAX_INBOUND_FRAMES: usize = 256;

/// A live debug **adapter**: the ADR-0106 D2 host-owned streaming subprocess, the ADR-0102
/// `LspServer` shape applied to DAP. A writer thread owns its piped stdin (Content-Length
/// framed writes fed by a bounded queue), a reader thread drains framed messages off stdout
/// into a channel, and the handle tree-kills the adapter exactly once. Owned by the host
/// inside its session map. This is ONLY the adapter (the protocol translator); the debuggee
/// (the program being debugged) is launched separately through the ADR-0104 substrate (D3)
/// and supervised alongside it (D6).
pub struct DapAdapter {
    adapter_id: String,
    child: Child,
    process_id: u32,
    /// Sender feeding the writer thread; dropping it closes stdin (EOF to the adapter).
    writer_tx: Option<SyncSender<Value>>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    /// Set once the process tree has been signalled, so it is signalled exactly once across
    /// `close_and_kill` + `Drop`.
    killed: bool,
}

impl Drop for DapAdapter {
    fn drop(&mut self) {
        // Disconnect the writer (closes stdin, EOF to the adapter), kill the whole tree once,
        // and join both pump threads, so dropping the handle (session-end / disconnect /
        // token-revocation / root-removal, D6) tears the adapter down deterministically.
        self.writer_tx.take();
        self.kill_tree_once();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl DapAdapter {
    /// Spawn the located `program` with `args` in `root`, shell-free and in its own process
    /// group, with piped stdio. `program`/`args` come from the host-owned adapter table
    /// ([`resolve_adapter`] + [`locate`]), never from the client (ADR-0106 D2). Returns the
    /// handle plus a receiver of every inbound DAP message the adapter frames on stdout.
    pub fn spawn(
        program: OsString,
        args: &[&str],
        root: &str,
        adapter_id: impl Into<String>,
    ) -> Result<(Self, Receiver<Value>), BridgeError> {
        let mut command = Command::new(&program);
        command
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Own process group (unix) so a later kill takes the whole tree, adapter and any
        // debugger child included; no-op on Windows, where `taskkill /T` walks by pid.
        put_in_own_process_group(&mut command);

        let adapter_id = adapter_id.into();
        let display = program.to_string_lossy().into_owned();
        // Audit line (ADR-0106 D7): every adapter spawn is host-logged with the root, adapter
        // id, and resolved binary, so a running debug session is traceable from the console.
        eprintln!(
            "[dap] running '{adapter_id}' in {root}: {display} {}",
            args.join(" ")
        );
        let mut child = command.spawn().map_err(|error| {
            BridgeError::new(
                "dap_spawn_failed",
                format!("failed to launch debug adapter '{display}': {error}"),
            )
        })?;
        let process_id = child.id();
        let stdin = child.stdin.take().ok_or_else(|| {
            BridgeError::new("dap_spawn_failed", "debug adapter exposed no stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            BridgeError::new("dap_spawn_failed", "debug adapter exposed no stdout")
        })?;

        // Drain stderr on its own thread so a chatty adapter cannot fill the stderr pipe and
        // wedge itself while we read stdout.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut sink = std::io::sink();
                let _ = std::io::copy(&mut reader, &mut sink);
            });
        }

        let (sender, receiver) = std::sync::mpsc::sync_channel::<Value>(MAX_INBOUND_FRAMES);
        let reader = std::thread::spawn(move || read_frames(BufReader::new(stdout), &sender));

        // The writer thread owns stdin: callers enqueue frames (bounded, non-blocking) and
        // this thread does the blocking framed writes, so a slow adapter never blocks the
        // host. It exits when the queue disconnects (handle dropped) or a write fails (adapter
        // gone); dropping stdin on exit is the EOF the adapter sees.
        let (writer_tx, writer_rx) =
            std::sync::mpsc::sync_channel::<Value>(MAX_QUEUED_OUTBOUND_FRAMES);
        let mut stdin = stdin;
        let writer = std::thread::spawn(move || {
            while let Ok(message) = writer_rx.recv() {
                let framed = frame_message(&message);
                if stdin
                    .write_all(&framed)
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    return;
                }
            }
        });

        Ok((
            Self {
                adapter_id,
                child,
                process_id,
                writer_tx: Some(writer_tx),
                writer: Some(writer),
                reader: Some(reader),
                killed: false,
            },
            receiver,
        ))
    }

    /// The allowlist adapter id this process is running for.
    pub fn adapter_id(&self) -> &str {
        &self.adapter_id
    }

    /// The OS process id, captured at spawn.
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Enqueue a DAP `message` for the writer thread, which frames and writes it to the
    /// adapter's stdin. Never blocks: errors with `dap_not_running` when the writer is gone
    /// (adapter exited), or `dap_backpressure` when the bounded queue is full (a wedged
    /// adapter), so a slow adapter can never stall the host.
    pub fn write_message(&mut self, message: &Value) -> Result<(), BridgeError> {
        let sender = self
            .writer_tx
            .as_ref()
            .ok_or_else(|| BridgeError::new("dap_not_running", "debug adapter stdin is closed"))?;
        match sender.try_send(message.clone()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(BridgeError::new(
                "dap_backpressure",
                "debug adapter is not draining its input; frame dropped",
            )),
            Err(TrySendError::Disconnected(_)) => Err(BridgeError::new(
                "dap_not_running",
                "debug adapter stdin is closed",
            )),
        }
    }

    /// Observe process exit: `Some(success)` once the adapter has exited, `None` while it is
    /// still running. The host's session watchdog polls this to reap a crashed adapter.
    pub fn poll_exit(&mut self) -> Option<bool> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.success()),
            _ => None,
        }
    }

    /// Close stdin (via the writer) and kill the whole process tree (once). Idempotent with
    /// `Drop`. Teardown prefers a graceful DAP `disconnect`/`terminate` (sent by the host
    /// before calling this); this is the fallback tree-kill so no adapter outlives the
    /// session (ADR-0106 D6).
    pub fn close_and_kill(&mut self) {
        self.writer_tx.take();
        self.kill_tree_once();
    }

    fn kill_tree_once(&mut self) {
        if !self.killed {
            kill_process_tree(&mut self.child);
            self.killed = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::BufReader;

    #[test]
    fn resolves_allowlisted_adapters_and_denies_others() {
        // The one Slice A adapter resolves to its fixed, host-owned launch spec.
        let spec = resolve_adapter("netcoredbg").expect("netcoredbg is allowlisted");
        assert_eq!(spec.program, "netcoredbg");
        assert_eq!(spec.args, &["--interpreter=vscode"]);

        // An unknown id (or a command line masquerading as one) is refused, never executed.
        assert!(resolve_adapter("bash").is_none());
        assert!(resolve_adapter("netcoredbg; rm -rf /").is_none());
        assert!(resolve_adapter("").is_none());
    }

    #[test]
    fn maps_languages_to_adapters_for_the_honest_flag() {
        assert_eq!(adapter_for_language("csharp"), Some("netcoredbg"));
        // A language with no allowlisted adapter degrades to Run-only, not an error.
        assert_eq!(adapter_for_language("rust"), None);
        assert_eq!(adapter_for_language("python"), None);
    }

    #[test]
    fn dap_status_is_honest_about_absence() {
        // With no adapter binary installed on the test PATH, csharp maps to netcoredbg but
        // reports not-installed (Run stays available); an unknown language reports no adapter.
        let csharp = dap_status("csharp");
        assert_eq!(csharp.adapter_id, "netcoredbg");
        assert!(csharp.reason.contains("Run is still available") || csharp.installed);

        let unknown = dap_status("python");
        assert_eq!(unknown.adapter_id, "");
        assert!(!unknown.installed);
    }

    #[test]
    fn frames_a_message_with_a_byte_accurate_content_length() {
        let framed = frame_message(&json!({ "seq": 1, "type": "request", "command": "next" }));
        let text = String::from_utf8(framed).expect("framed message is UTF-8");
        let (header, body) = text.split_once("\r\n\r\n").expect("header/body separator");
        let declared: usize = header
            .strip_prefix("Content-Length:")
            .expect("Content-Length header")
            .trim()
            .parse()
            .expect("length parses");
        assert_eq!(
            declared,
            body.len(),
            "declared length matches the JSON body bytes"
        );
    }

    #[test]
    fn reads_the_content_length_and_ignores_other_headers() {
        let mut reader = BufReader::new(
            &b"Content-Type: application/vscode-jsonrpc\r\nContent-Length: 42\r\n\r\n"[..],
        );
        assert_eq!(read_content_length(&mut reader), Some(42));

        // EOF before any header block ends the reader (the host observes adapter exit).
        let mut empty = BufReader::new(&b""[..]);
        assert_eq!(read_content_length(&mut empty), None);
    }

    /// A trivial process that exits immediately, for the spawn/kill lifecycle test without a
    /// real adapter installed (the framed proxy round-trip is covered separately).
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
    fn adapter_spawn_kill_lifecycle_is_idempotent() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let (program, args) = quick_command();
        let (mut adapter, _inbound) =
            DapAdapter::spawn(program, &args, &root, "netcoredbg").expect("spawn quick command");
        assert!(adapter.process_id() > 0);
        assert_eq!(adapter.adapter_id(), "netcoredbg");
        // Explicit kills and the implicit Drop must not double-signal a reaped pid.
        adapter.close_and_kill();
        adapter.close_and_kill();
        // Dropping at end of scope is the third potential kill; it must be a no-op.
    }

    #[test]
    fn write_message_after_close_reports_not_running() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let (program, args) = quick_command();
        let (mut adapter, _inbound) =
            DapAdapter::spawn(program, &args, &root, "netcoredbg").expect("spawn quick command");
        adapter.close_and_kill();
        let err = adapter
            .write_message(&json!({ "seq": 1, "type": "request", "command": "next" }))
            .expect_err("writing to a closed adapter is refused, not a panic");
        assert_eq!(err.code, "dap_not_running");
    }

    #[test]
    fn frame_round_trips_through_read_content_length() {
        let framed = frame_message(&json!({ "type": "event", "event": "stopped" }));
        let mut reader = BufReader::new(&framed[..]);
        let len = read_content_length(&mut reader).expect("length is read back");
        let mut body = vec![0_u8; len];
        reader.read_exact(&mut body).expect("body reads exactly");
        let value: Value = serde_json::from_slice(&body).expect("body is the JSON we framed");
        assert_eq!(value["event"], "stopped");
    }
}
