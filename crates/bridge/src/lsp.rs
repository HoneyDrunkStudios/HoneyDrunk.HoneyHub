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
//! The proxy is a **URI-validating gateway, not a dumb pipe** (ADR-0102 D-G). LSP frames
//! carry file URIs in both directions that can name paths beyond the spawn root, so the
//! host enforces the same allowlist boundary on the frames it proxies:
//!
//! - **Client to server** ([`sanitize_client_message`]): command-bearing and
//!   configuration-bearing methods (`workspace/executeCommand`,
//!   `workspace/didChangeConfiguration`) are denied by default, client
//!   `initializationOptions` are stripped (configuration is host-owned: settings can
//!   carry tool paths and override commands), and every file URI in the frame
//!   (`rootUri`, `workspaceFolders`, `textDocument.uri`, ...) must resolve inside an
//!   allowlisted workspace root or the frame is refused, not forwarded.
//! - **Server to client** ([`filter_server_message`]): location results and file-watch
//!   registrations are filtered to allowlisted roots; server-initiated
//!   `workspace/applyEdit` is denied outright (`applied: false`; operator-initiated
//!   WorkspaceEdit responses still flow as buffer-edit proposals persisted only via
//!   `write_file`); out-of-root or non-file `window/showDocument` requests are refused;
//!   `workspace/configuration` requests are answered by the host itself (never an opaque
//!   client payload); server-defined command payloads on code actions / code lenses are
//!   stripped (their execution path, `workspace/executeCommand`, is refused anyway).
//!
//! Beyond that boundary the payload is not interpreted: the framing layer stays
//! protocol-shaped and the bridge owns *which* server may run, *where* it runs, and
//! *what the wire may name* — never the semantics of a completion or a hover.

use crate::adapter::BridgeError;
use crate::adapters::child_run::{kill_process_tree, put_in_own_process_group};
use crate::backend_catalog::resolve_program;
use crate::pairing::WorkspaceAllowlist;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
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

/// Bound on queued-but-unwritten outbound frames per server. Writes happen on a dedicated
/// writer thread so a slow or wedged server can never block the caller (the host would
/// otherwise stall every LSP operation while holding its server map lock); the bound keeps
/// a wedged server from accumulating frames without limit. didChange bursts sit far below
/// this.
const MAX_QUEUED_OUTBOUND_FRAMES: usize = 256;

/// A live language server: a writer thread owning its piped stdin (Content-Length framed
/// writes, fed by a bounded queue), the reader thread draining framed messages off stdout
/// into a channel, and the bookkeeping to kill the tree exactly once. Owned by the host
/// inside a `Mutex<HashMap<..>>`, one per (language, root).
pub struct LspServer {
    server_id: String,
    child: Child,
    process_id: u32,
    /// Sender feeding the writer thread; dropping it closes stdin (EOF to the server).
    writer_tx: Option<std::sync::mpsc::SyncSender<Value>>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    /// Set once the process tree has been signalled, so it is signalled exactly once
    /// across `close_and_kill` + `Drop`.
    killed: bool,
}

impl Drop for LspServer {
    fn drop(&mut self) {
        // Disconnect the writer (which closes stdin, EOF to the server), kill the whole
        // tree once, and join both pump threads, so dropping the handle (stop /
        // session-end / disconnect / root-removal) tears the process down
        // deterministically.
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

        let server_id = server_id.into();
        let display = program.to_string_lossy().into_owned();
        // Audit line (ADR-0102 D-C): every language-server spawn is host-logged with the
        // root, server id, and resolved program, so running servers are traceable from
        // the bridge console.
        eprintln!(
            "[lsp] running '{server_id}' in {root}: {display} {}",
            args.join(" ")
        );
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

        // The writer thread owns stdin: callers enqueue frames (bounded, non-blocking)
        // and this thread does the blocking framed writes, so a slow server never blocks
        // the host. It exits when the queue disconnects (handle dropped) or a write
        // fails (server gone); dropping stdin on exit is the EOF the server sees.
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
                server_id,
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

    /// The allowlist server id this process is running for.
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    /// The OS process id, captured at spawn.
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Enqueue `message` for the writer thread, which frames (Content-Length) and writes
    /// it to the server's stdin. Never blocks: errors with `lsp_not_running` when the
    /// writer is gone (stdin closed / server exited), or `lsp_backpressure` when the
    /// bounded queue is full (a wedged server), so a slow server can never stall the
    /// caller.
    pub fn write_message(&mut self, message: &Value) -> Result<(), BridgeError> {
        let sender = self.writer_tx.as_ref().ok_or_else(|| {
            BridgeError::new("lsp_not_running", "language server stdin is closed")
        })?;
        match sender.try_send(message.clone()) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::TrySendError::Full(_)) => Err(BridgeError::new(
                "lsp_backpressure",
                "language server is not draining its input; frame dropped",
            )),
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => Err(BridgeError::new(
                "lsp_not_running",
                "language server stdin is closed",
            )),
        }
    }

    /// Observe process exit: `Some(success)` once the child has exited, `None` while it is
    /// still running.
    pub fn poll_exit(&mut self) -> Option<bool> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.success()),
            _ => None,
        }
    }

    /// Close stdin (via the writer) and kill the whole process tree (once). Idempotent
    /// with `Drop`.
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

/// Client-to-server LSP methods denied by default (ADR-0102 D-G): command identifiers /
/// arguments and configuration payloads are server-defined and opaque, and configuration
/// is behavior-DEFINING for many servers (tool paths, override commands, plugins), so
/// neither can be validated into safety. Enabling a command or a client-tunable setting
/// is a host-owned, named, validated surface recorded by an ADR amendment — never a
/// pass-through.
const DENIED_CLIENT_METHODS: &[&str] = &[
    "workspace/executeCommand",
    "workspace/didChangeConfiguration",
];

/// JSON keys whose string values name documents or locations in LSP frames. Keyed matching
/// (rather than scanning every string) keeps document *content* — which may legitimately
/// contain the text `file:///...` — out of the boundary check.
const URI_KEYS: &[&str] = &[
    "uri",
    "rootUri",
    "targetUri",
    "scopeUri",
    "baseUri",
    "newUri",
    "oldUri",
];

/// Validate and sanitize a client-to-server LSP frame against the workspace allowlist
/// (ADR-0102 D-G). A denied method or an out-of-root file URI refuses the whole frame —
/// it is rejected, not forwarded, and the caller surfaces the denial to the client.
/// Configuration is host-owned: client-supplied `initialize.initializationOptions` are
/// stripped in place (the host's per-server configuration is the only source; none is
/// defined at v1), because settings can carry tool paths, override commands, and plugins
/// — an execution surface no URI check can bound.
pub fn sanitize_client_message(
    message: &mut Value,
    allowlist: &WorkspaceAllowlist,
) -> Result<(), BridgeError> {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(method) = method.as_deref() {
        if DENIED_CLIENT_METHODS.contains(&method) {
            return Err(BridgeError::new(
                "lsp_method_denied",
                format!(
                    "LSP method '{method}' is denied by default (ADR-0102 D-G): commands \
                     and configuration are opaque server-defined behavior; enabling one \
                     requires a host-owned named surface"
                ),
            ));
        }
        if method == "initialize" {
            if let Some(Value::Object(params)) = message.get_mut("params") {
                // Host-owned configuration (ADR-0102 D-G): never forward an opaque
                // client payload that can redefine what the server executes.
                params.remove("initializationOptions");
            }
        }
    }
    match first_denied_uri(message, allowlist) {
        None => Ok(()),
        Some(uri) => Err(BridgeError::new(
            "lsp_uri_denied",
            format!("LSP frame names a file outside every allowlisted workspace root: {uri}"),
        )),
    }
}

/// What the host does with one server-to-client frame after boundary filtering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerFrameAction {
    /// Forward the (possibly scrubbed) frame to the cockpit.
    Forward(Value),
    /// Drop the frame entirely (an out-of-root notification).
    Drop,
    /// Do not forward; write this synthesized response back to the **server** instead. A
    /// denied server-initiated request must still be answered or the server hangs on it.
    Reply(Value),
}

/// Filter a server-to-client LSP frame to the workspace allowlist (ADR-0102 D-G):
///
/// - out-of-root array entries (locations, watch registrations, code actions whose edit
///   names an out-of-root file) are removed and command payloads stripped;
/// - server-initiated `workspace/applyEdit` is **denied by default**: every such request
///   gets a synthesized `applied: false` reply (mutation carries operator intent only via
///   the write_file save path; operator-initiated WorkspaceEdit RESPONSES still flow, as
///   buffer-edit proposals);
/// - a denied `window/showDocument` gets a `success: false` reply (non-file and
///   out-of-root targets are never auto-opened);
/// - a response left naming an out-of-root target gets a null `result` (dropping a
///   response outright would hang the client's request);
/// - any other denied request is answered with a JSON-RPC error; a denied notification
///   is dropped.
pub fn filter_server_message(
    mut message: Value,
    allowlist: &WorkspaceAllowlist,
) -> ServerFrameAction {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    let id = message.get("id").cloned();

    // window/showDocument can steer the editor (or a browser) anywhere; only an in-root
    // file target may pass. External (http/https) targets are never auto-opened.
    if method.as_deref() == Some("window/showDocument") {
        let target = message
            .get("params")
            .and_then(|params| params.get("uri"))
            .and_then(Value::as_str);
        let allowed = target.is_some_and(|uri| {
            file_uri_to_path(uri).is_some_and(|path| path_allowed(&path, allowlist))
        });
        if !allowed {
            return match id {
                Some(id) => ServerFrameAction::Reply(serde_json::json!({
                    "jsonrpc": "2.0", "id": id, "result": { "success": false }
                })),
                None => ServerFrameAction::Drop,
            };
        }
    }

    // workspace/configuration is the server asking the CLIENT for settings; configuration
    // is host-owned (ADR-0102 D-G), so the host answers from its own per-server table
    // (empty at v1: one null per requested item, the protocol's "no setting" value) and
    // the request never reaches an opaque client payload.
    if method.as_deref() == Some("workspace/configuration") {
        return match id {
            Some(id) => {
                let count = message
                    .pointer("/params/items")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                ServerFrameAction::Reply(serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": vec![Value::Null; count]
                }))
            }
            None => ServerFrameAction::Drop,
        };
    }

    // Server-initiated workspace/applyEdit is denied by default (ADR-0102 D-G): a
    // subprocess-initiated file-mutation trigger carries no operator intent, and mutation
    // is ADR-0097's domain. Operator-initiated WorkspaceEdits (rename / code-action
    // RESPONSES) still reach the editor as buffer-edit proposals and persist only through
    // the write_file save path.
    if method.as_deref() == Some("workspace/applyEdit") {
        return match id {
            Some(id) => ServerFrameAction::Reply(serde_json::json!({
                "jsonrpc": "2.0", "id": id, "result": {
                    "applied": false,
                    "failureReason": "HoneyHub denies server-initiated edits (ADR-0102 \
                                      D-G): edits flow as responses to operator-initiated \
                                      requests and persist only through write_file"
                }
            })),
            None => ServerFrameAction::Drop,
        };
    }

    if scrub(&mut message, allowlist) {
        return ServerFrameAction::Forward(message);
    }
    let is_response = id.is_some() && method.is_none();
    if is_response {
        if let Value::Object(map) = &mut message {
            map.insert("result".to_string(), Value::Null);
        }
        return ServerFrameAction::Forward(message);
    }
    match id {
        // A denied server request other than the shapes above still gets an answer so the
        // server never hangs on it.
        Some(id) => ServerFrameAction::Reply(serde_json::json!({
            "jsonrpc": "2.0", "id": id, "error": {
                "code": -32600,
                "message": "denied by the HoneyHub LSP URI boundary (ADR-0102 D-G)"
            }
        })),
        None => ServerFrameAction::Drop,
    }
}

/// Depth-first search for the first URI (or `rootPath`) that resolves outside every
/// allowlisted root. Only URI-keyed strings are checked, so document content never
/// trips the boundary.
fn first_denied_uri<'a>(value: &'a Value, allowlist: &WorkspaceAllowlist) -> Option<&'a str> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                // WorkspaceEdit.changes is a map KEYED by document URI.
                if key == "changes" {
                    if let Value::Object(changes) = child {
                        for uri in changes.keys() {
                            if !uri_allowed(uri, allowlist) {
                                return Some(uri);
                            }
                        }
                    }
                }
                if let Some(text) = child.as_str() {
                    if URI_KEYS.contains(&key.as_str()) && !uri_allowed(text, allowlist) {
                        return Some(text);
                    }
                    // The deprecated `rootPath` initialize field carries a plain path.
                    if key == "rootPath"
                        && Path::new(text).is_absolute()
                        && !path_allowed(Path::new(text), allowlist)
                    {
                        return Some(text);
                    }
                }
                if let Some(found) = first_denied_uri(child, allowlist) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| first_denied_uri(item, allowlist)),
        _ => None,
    }
}

/// Scrub a server-to-client value in place: drop out-of-root entries from arrays and from
/// URI-keyed `changes` maps, and strip server-defined command payloads. Returns whether the
/// value is clean; dirty means a violation remains that could not be removed locally (the
/// caller drops or nulls the enclosing message).
fn scrub(value: &mut Value, allowlist: &WorkspaceAllowlist) -> bool {
    match value {
        Value::Array(items) => {
            // A bare `Command` element (legacy code-action shape) is meaningless once its
            // execution path is refused — drop it with the out-of-root entries.
            items.retain_mut(|item| !is_bare_command(item) && scrub(item, allowlist));
            true
        }
        Value::Object(map) => {
            // A `Command` attached to a code action / code lens / completion item is a
            // server-defined side effect; its execution path (executeCommand) is refused,
            // so strip the payload rather than surface a dead affordance.
            if map.get("command").is_some_and(is_command_payload) {
                map.remove("command");
            }
            let mut clean = true;
            for (key, child) in map.iter_mut() {
                // A WorkspaceEdit (under an `edit` key, e.g. inside a code action) is an
                // all-or-nothing protocol contract: it is never internally filtered. Any
                // out-of-root target marks the WHOLE containing object dirty, so a bad
                // code action drops from its array whole and a bad applyEdit rejects
                // whole (see filter_server_message), never applies a subset.
                if key == "edit" {
                    if first_denied_uri(child, allowlist).is_some() {
                        clean = false;
                    }
                    continue;
                }
                // WorkspaceEdit.changes at this level (a map keyed by document URI): the
                // same atomicity rule, an out-of-root key dirties the container.
                if key == "changes" {
                    if let Value::Object(changes) = child {
                        if changes.keys().any(|uri| !uri_allowed(uri, allowlist)) {
                            clean = false;
                        }
                        continue;
                    }
                }
                if URI_KEYS.contains(&key.as_str()) {
                    if let Some(text) = child.as_str() {
                        if !uri_allowed(text, allowlist) {
                            clean = false;
                        }
                        continue;
                    }
                }
                if !scrub(child, allowlist) {
                    clean = false;
                }
            }
            clean
        }
        _ => true,
    }
}

/// A bare `Command` literal (`{"title": ..., "command": "server.cmd"}`) surfaced as an
/// array element — the legacy code-action shape.
fn is_bare_command(value: &Value) -> bool {
    value.get("title").is_some() && value.get("command").is_some_and(Value::is_string)
}

/// A command payload under a `command` key: either a `Command` object or a plain
/// command-identifier string.
fn is_command_payload(value: &Value) -> bool {
    value.is_string() || (value.is_object() && value.get("command").is_some_and(Value::is_string))
}

/// Whether a URI may cross the wire: non-`file:` schemes carry no filesystem authority and
/// pass; a `file:` URI must resolve inside an allowlisted root.
fn uri_allowed(uri: &str, allowlist: &WorkspaceAllowlist) -> bool {
    match file_uri_to_path(uri) {
        None => true,
        Some(path) => path_allowed(&path, allowlist),
    }
}

/// Whether a filesystem path canonicalizes inside an allowlisted root. A not-yet-existing
/// target (a create/rename edit) is judged by its nearest existing ancestor — the same
/// parent-dir posture `write_file` uses (ADR-0097).
fn path_allowed(path: &Path, allowlist: &WorkspaceAllowlist) -> bool {
    let mut current = path;
    loop {
        if current.exists() {
            return allowlist.allows(&current.to_string_lossy());
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => return false,
        }
    }
}

/// Convert a `file:` URI to a filesystem path (percent-decoded, Windows-drive and UNC
/// aware). `None` = not a `file:` URI.
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    if uri.len() < 7 || !uri[..7].eq_ignore_ascii_case("file://") {
        return None;
    }
    let rest = &uri[7..];
    let (authority, encoded_path) = match rest.find('/') {
        Some(0) => ("", rest),
        Some(slash) => (&rest[..slash], &rest[slash..]),
        None => (rest, ""),
    };
    let decoded = percent_decode(encoded_path);
    if authority.is_empty() || authority.eq_ignore_ascii_case("localhost") {
        // "/c:/dir" (or "/c%3A/dir") spells a Windows drive path behind a leading slash.
        let bytes = decoded.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            return Some(PathBuf::from(&decoded[1..]));
        }
        Some(PathBuf::from(decoded))
    } else {
        // "file://server/share/..." names a UNC path.
        Some(PathBuf::from(format!("\\\\{authority}{decoded}")))
    }
}

/// Percent-decode a URI path component (bytes, then lossy UTF-8).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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

    // ---- ADR-0102 D-G URI boundary + command-surface deny ----

    /// An allowlist containing exactly the temp dir, plus a file URI inside it and one
    /// outside it. The in-root file is created so the exists()/canonicalize path runs.
    fn boundary_fixture() -> (WorkspaceAllowlist, String, String) {
        let root = std::env::temp_dir();
        let inside = root.join("hh-lsp-boundary-test.rs");
        std::fs::write(&inside, b"fn main() {}").expect("write fixture file");
        let allowlist = WorkspaceAllowlist::new(vec![root.to_string_lossy().into_owned()]);
        (
            allowlist,
            to_file_uri(&inside),
            "file:///etc/passwd".to_string(),
        )
    }

    fn to_file_uri(path: &Path) -> String {
        let slashed = path.to_string_lossy().replace('\\', "/");
        // A Unix absolute path already starts with '/'; a Windows drive path needs one.
        let separator = if slashed.starts_with('/') { "" } else { "/" };
        format!("file://{separator}{slashed}")
    }

    #[test]
    fn file_uri_parsing_handles_drives_encoding_and_schemes() {
        assert_eq!(
            file_uri_to_path("file:///c:/work/repo/src/main.rs"),
            Some(PathBuf::from("c:/work/repo/src/main.rs"))
        );
        // Percent-encoded drive colon and spaces decode before the path is judged.
        assert_eq!(
            file_uri_to_path("file:///c%3A/work/my%20repo/a.rs"),
            Some(PathBuf::from("c:/work/my repo/a.rs"))
        );
        assert_eq!(
            file_uri_to_path("file:///home/oleg/repo/lib.rs"),
            Some(PathBuf::from("/home/oleg/repo/lib.rs"))
        );
        // Non-file schemes carry no filesystem authority.
        assert_eq!(file_uri_to_path("untitled:Untitled-1"), None);
        assert_eq!(file_uri_to_path("https://example.com/x"), None);
    }

    #[test]
    fn client_frames_with_out_of_root_uris_are_refused() {
        let (allowlist, inside, outside) = boundary_fixture();
        let mut ok = serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/hover",
            "params": { "textDocument": { "uri": inside } }
        });
        assert!(sanitize_client_message(&mut ok, &allowlist).is_ok());

        let mut bad = serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": outside, "text": "x" } }
        });
        let error = sanitize_client_message(&mut bad, &allowlist).expect_err("must refuse");
        assert_eq!(error.code, "lsp_uri_denied");

        // Runtime workspace-folder additions are gated the same way (nested arrays).
        let mut folders = serde_json::json!({
            "jsonrpc": "2.0", "method": "workspace/didChangeWorkspaceFolders",
            "params": { "event": { "added": [ { "uri": outside, "name": "x" } ], "removed": [] } }
        });
        assert!(sanitize_client_message(&mut folders, &allowlist).is_err());
    }

    #[test]
    fn document_content_containing_a_file_uri_does_not_trip_the_boundary() {
        let (allowlist, inside, _) = boundary_fixture();
        // The *content* of a didChange legitimately can contain the text "file:///etc/..." —
        // only URI-keyed fields are judged.
        let mut message = serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/didChange",
            "params": {
                "textDocument": { "uri": inside, "version": 2 },
                "contentChanges": [ { "text": "let s = \"file:///etc/passwd\";" } ]
            }
        });
        assert!(sanitize_client_message(&mut message, &allowlist).is_ok());
    }

    #[test]
    fn execute_command_is_denied_by_default() {
        let (allowlist, _, _) = boundary_fixture();
        let mut message = serde_json::json!({
            "jsonrpc": "2.0", "id": 7, "method": "workspace/executeCommand",
            "params": { "command": "rust-analyzer.runSingle", "arguments": [] }
        });
        let error = sanitize_client_message(&mut message, &allowlist).expect_err("must deny");
        assert_eq!(error.code, "lsp_method_denied");
    }

    #[test]
    fn configuration_surfaces_are_host_owned() {
        let (allowlist, inside, _) = boundary_fixture();
        // Client initializationOptions are stripped: configuration is host-owned, and an
        // opaque payload could redefine what the server executes (tool paths, plugins).
        let mut init = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "rootUri": inside,
                "initializationOptions": { "checkOnSave": { "overrideCommand": ["curl", "evil"] } },
                "capabilities": {}
            }
        });
        assert!(sanitize_client_message(&mut init, &allowlist).is_ok());
        assert!(init.pointer("/params/initializationOptions").is_none());
        assert!(init.pointer("/params/capabilities").is_some());

        // didChangeConfiguration is denied outright.
        let mut change = serde_json::json!({
            "jsonrpc": "2.0", "method": "workspace/didChangeConfiguration",
            "params": { "settings": { "anything": true } }
        });
        let error = sanitize_client_message(&mut change, &allowlist).expect_err("must deny");
        assert_eq!(error.code, "lsp_method_denied");

        // A server workspace/configuration request is answered by the HOST (null per
        // requested item), never forwarded to an opaque client payload.
        let request = serde_json::json!({
            "jsonrpc": "2.0", "id": 12, "method": "workspace/configuration",
            "params": { "items": [ { "section": "rust-analyzer" }, { "section": "files" } ] }
        });
        let ServerFrameAction::Reply(reply) = filter_server_message(request, &allowlist) else {
            panic!("expected Reply");
        };
        assert_eq!(reply.get("id"), Some(&serde_json::json!(12)));
        assert_eq!(reply.get("result"), Some(&serde_json::json!([null, null])));
    }

    #[test]
    fn server_location_arrays_are_filtered_to_allowlisted_roots() {
        let (allowlist, inside, outside) = boundary_fixture();
        let response = serde_json::json!({
            "jsonrpc": "2.0", "id": 3,
            "result": [
                { "uri": inside, "range": {} },
                { "uri": outside, "range": {} }
            ]
        });
        let ServerFrameAction::Forward(filtered) = filter_server_message(response, &allowlist)
        else {
            panic!("expected Forward");
        };
        let result = filtered
            .get("result")
            .and_then(Value::as_array)
            .expect("array");
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].get("uri").and_then(Value::as_str),
            Some(inside.as_str())
        );
    }

    #[test]
    fn a_response_left_naming_an_out_of_root_target_gets_a_null_result() {
        let (allowlist, _, outside) = boundary_fixture();
        // A single-Location definition result cannot be array-filtered; dropping the
        // response would hang the client's request, so the result nulls instead.
        let response = serde_json::json!({
            "jsonrpc": "2.0", "id": 4,
            "result": { "uri": outside, "range": {} }
        });
        let ServerFrameAction::Forward(filtered) = filter_server_message(response, &allowlist)
        else {
            panic!("expected Forward");
        };
        assert!(filtered.get("result").expect("result").is_null());
    }

    #[test]
    fn out_of_root_notifications_and_show_document_are_dropped() {
        let (allowlist, inside, outside) = boundary_fixture();
        let diagnostics = serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
            "params": { "uri": outside, "diagnostics": [] }
        });
        assert_eq!(
            filter_server_message(diagnostics, &allowlist),
            ServerFrameAction::Drop
        );

        // showDocument: out-of-root and non-file (external) targets never auto-open; the
        // server request is answered success: false rather than left hanging.
        let external = serde_json::json!({
            "jsonrpc": "2.0", "id": 9, "method": "window/showDocument",
            "params": { "uri": "https://example.com/docs" }
        });
        let ServerFrameAction::Reply(reply) = filter_server_message(external, &allowlist) else {
            panic!("expected Reply");
        };
        assert_eq!(reply.pointer("/result/success"), Some(&Value::Bool(false)));
        assert_eq!(reply.get("id"), Some(&serde_json::json!(9)));
        let in_root = serde_json::json!({
            "jsonrpc": "2.0", "id": 10, "method": "window/showDocument",
            "params": { "uri": inside }
        });
        assert!(matches!(
            filter_server_message(in_root, &allowlist),
            ServerFrameAction::Forward(_)
        ));
    }

    #[test]
    fn server_initiated_apply_edit_is_denied_by_default() {
        let (allowlist, inside, _) = boundary_fixture();
        // Even a fully in-root edit is denied: a subprocess-initiated mutation trigger
        // carries no operator intent (ADR-0102 D-G); the server gets applied: false and
        // the editor sees nothing. Operator-initiated WorkspaceEdit RESPONSES (rename /
        // code action) still flow, covered by the code-action tests below.
        let request = serde_json::json!({
            "jsonrpc": "2.0", "id": 5, "method": "workspace/applyEdit",
            "params": { "edit": { "changes": {
                (inside.clone()): [ { "newText": "x", "range": {} } ]
            } } }
        });
        let ServerFrameAction::Reply(reply) = filter_server_message(request, &allowlist) else {
            panic!("expected Reply");
        };
        assert_eq!(reply.pointer("/result/applied"), Some(&Value::Bool(false)));
        assert!(reply.pointer("/result/failureReason").is_some());
        assert_eq!(reply.get("id"), Some(&serde_json::json!(5)));
    }

    #[test]
    fn an_operator_initiated_rename_response_flows_as_a_buffer_proposal() {
        let (allowlist, inside, outside) = boundary_fixture();
        // A rename RESPONSE (operator-initiated) carries a WorkspaceEdit; it forwards
        // when in-root (a buffer-edit proposal, persisted only via write_file)...
        let clean = serde_json::json!({
            "jsonrpc": "2.0", "id": 6,
            "result": { "changes": { (inside.clone()): [ { "newText": "x", "range": {} } ] } }
        });
        assert!(matches!(
            filter_server_message(clean, &allowlist),
            ServerFrameAction::Forward(_)
        ));
        // ...and a response whose edit reaches out-of-root gets a null result (atomic:
        // never a partially filtered edit set).
        let dirty = serde_json::json!({
            "jsonrpc": "2.0", "id": 7,
            "result": { "changes": {
                (inside.clone()): [ { "newText": "x", "range": {} } ],
                (outside.clone()): [ { "newText": "y", "range": {} } ]
            } }
        });
        let ServerFrameAction::Forward(filtered) = filter_server_message(dirty, &allowlist) else {
            panic!("expected Forward");
        };
        assert!(filtered.get("result").expect("result").is_null());
    }

    #[test]
    fn a_code_action_with_an_out_of_root_edit_drops_whole_from_its_array() {
        let (allowlist, inside, outside) = boundary_fixture();
        // Each code action edit is atomic too: an action whose edit reaches out-of-root
        // drops WHOLE from the result list (never internally filtered), while its
        // in-root siblings survive.
        let response = serde_json::json!({
            "jsonrpc": "2.0", "id": 11,
            "result": [
                { "title": "safe", "edit": { "changes": { (inside.clone()): [] } } },
                { "title": "unsafe", "edit": { "changes": { (outside.clone()): [] } } }
            ]
        });
        let ServerFrameAction::Forward(filtered) = filter_server_message(response, &allowlist)
        else {
            panic!("expected Forward");
        };
        let result = filtered
            .get("result")
            .and_then(Value::as_array)
            .expect("array");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].get("title").and_then(Value::as_str), Some("safe"));
    }

    #[test]
    fn a_new_file_edit_under_an_allowlisted_root_is_judged_by_its_ancestor() {
        let (allowlist, _, _) = boundary_fixture();
        let new_file = std::env::temp_dir()
            .join("hh-lsp-not-yet-created")
            .join("new.rs");
        assert!(path_allowed(&new_file, &allowlist));
        assert!(!path_allowed(
            Path::new("/definitely/not/allowlisted/new.rs"),
            &allowlist
        ));
    }

    #[test]
    fn command_payloads_are_stripped_and_bare_commands_dropped() {
        let (allowlist, inside, _) = boundary_fixture();
        let response = serde_json::json!({
            "jsonrpc": "2.0", "id": 6,
            "result": [
                // A code action carrying an edit keeps the edit, loses the command.
                { "title": "fix", "edit": { "changes": { (inside.clone()): [] } },
                  "command": { "title": "fix", "command": "server.fix" } },
                // A bare Command element (legacy shape) is dropped whole.
                { "title": "run it", "command": "server.run" }
            ]
        });
        let ServerFrameAction::Forward(filtered) = filter_server_message(response, &allowlist)
        else {
            panic!("expected Forward");
        };
        let result = filtered
            .get("result")
            .and_then(Value::as_array)
            .expect("array");
        assert_eq!(result.len(), 1);
        assert!(result[0].get("edit").is_some());
        assert!(result[0].get("command").is_none());
    }
}
