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
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
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
        let reader = std::thread::spawn(move || {
            crate::framing::read_frames(BufReader::new(stdout), MAX_LSP_MESSAGE_BYTES, |value| {
                sender.send(value).is_ok()
            })
        });

        // The writer thread owns stdin: callers enqueue frames (bounded, non-blocking)
        // and this thread does the blocking framed writes, so a slow server never blocks
        // the host. It exits when the queue disconnects (handle dropped) or a write
        // fails (server gone); dropping stdin on exit is the EOF the server sees.
        let (writer_tx, writer_rx) =
            std::sync::mpsc::sync_channel::<Value>(MAX_QUEUED_OUTBOUND_FRAMES);
        let mut stdin = stdin;
        let writer = std::thread::spawn(move || {
            while let Ok(message) = writer_rx.recv() {
                let framed = crate::framing::frame_message(&message);
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
    // `DocumentLink.target` is a bare `target` DocumentUri (go-to on a link); without this
    // a server could point a link at a file outside the allowlisted roots.
    "target",
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
                // Strip the DEPRECATED `rootPath` field: unlike `rootUri` /
                // `workspaceFolders` (which the URI walk validates), a relative
                // `rootPath` such as `..` or `../outside` carries no scheme for the
                // walk to canonicalize and could steer the server's workspace root
                // outside the allowlist. It is superseded by `rootUri` and safe to drop.
                params.remove("rootPath");
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
/// - a server-initiated **request** (id + method) is answered CENTRALLY by the host and
///   never forwarded, so a device-wide broadcast cannot make multiple cockpits answer one
///   request with duplicate ids: configuration gets host-owned null items, `applyEdit` is
///   denied (`applied: false`), `showDocument` is declined (`success: false`, not
///   auto-opened in v1), and every other request gets a generic accept (null);
/// - in a forwarded **response** or **notification**, out-of-root array entries (locations,
///   document links, code actions whose edit names an out-of-root file) are removed and
///   command-only code actions / code lenses are dropped whole;
/// - a response left naming an out-of-root target gets a null `result` (dropping a
///   response outright would hang the client's request); a dirty notification is dropped.
pub fn filter_server_message(
    mut message: Value,
    allowlist: &WorkspaceAllowlist,
) -> ServerFrameAction {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    let id = message.get("id").cloned();

    // A server-initiated REQUEST (both id and method present) is answered CENTRALLY by the
    // host and never forwarded. `lsp_message` is broadcast device-wide, so forwarding a
    // request would make every connected cockpit answer it with the same JSON-RPC id,
    // sending duplicate/conflicting responses to one server. The host answers exactly once.
    if let (Some(id), Some(method)) = (&id, method.as_deref()) {
        let result = match method {
            // Configuration is host-owned (ADR-0102 D-G): one null per requested item (the
            // protocol's "no setting" value), never an opaque client payload.
            "workspace/configuration" => {
                let count = message
                    .pointer("/params/items")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                Value::Array(vec![Value::Null; count])
            }
            // Server-initiated edits are denied (ADR-0102 D-G): mutation is operator-intent
            // only, via the ADR-0097 write_file save path. Operator-initiated WorkspaceEdit
            // RESPONSES (rename / code action) still flow as buffer proposals (below).
            "workspace/applyEdit" => serde_json::json!({
                "applied": false,
                "failureReason": "HoneyHub denies server-initiated edits (ADR-0102 D-G): \
                                  edits flow as responses to operator-initiated requests \
                                  and persist only through write_file"
            }),
            // HoneyHub does not auto-open server-requested documents in v1 (a
            // multi-cockpit "which editor opens it" question), so the request is honestly
            // declined rather than steering an out-of-root or ambiguous target.
            "window/showDocument" => serde_json::json!({ "success": false }),
            // Every other server request (registerCapability, unregisterCapability,
            // workDoneProgress/create, showMessageRequest, ...) gets a generic accept:
            // dynamic registrations and server prompts are not honored per-client, keeping
            // the host the single authority for server-request answers.
            _ => Value::Null,
        };
        return ServerFrameAction::Reply(serde_json::json!({
            "jsonrpc": "2.0", "id": id, "result": result
        }));
    }

    // From here the frame is a NOTIFICATION (method, no id) or a RESPONSE (id, no method).
    if scrub(&mut message, allowlist) {
        return ServerFrameAction::Forward(message);
    }
    // A response left naming an out-of-root target nulls its result (dropping it would hang
    // the client's request); a dirty notification is dropped.
    let is_response = id.is_some() && method.is_none();
    if is_response {
        if let Value::Object(map) = &mut message {
            map.insert("result".to_string(), Value::Null);
        }
        return ServerFrameAction::Forward(message);
    }
    ServerFrameAction::Drop
}

/// Depth-first search for the first URI that resolves outside every allowlisted root. Only
/// URI-keyed strings are checked, so document content never trips the boundary. (The
/// deprecated `rootPath` field is not path-checked here: it carries a scheme-less path a
/// relative value could slip past, so it is stripped outright at `initialize` in
/// [`sanitize_client_message`] rather than validated.)
fn first_denied_uri<'a>(value: &'a Value, allowlist: &WorkspaceAllowlist) -> Option<&'a str> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                // WorkspaceEdit.changes is a map KEYED by document URI.
                if key == "changes" {
                    if let Value::Object(changes) = child {
                        for uri in changes.keys() {
                            if !client_uri_allowed(uri, allowlist) {
                                return Some(uri);
                            }
                        }
                    }
                }
                if let Some(text) = child.as_str() {
                    if URI_KEYS.contains(&key.as_str()) && !client_uri_allowed(text, allowlist) {
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
            // A command-only code action / code lens is meaningless once its command is
            // refused, so it is dropped WHOLE (not stripped to an inert `{ title: ... }`
            // husk) along with any out-of-root entries. A completion item that also carries
            // a command survives with the command stripped (it still inserts text).
            items.retain_mut(|item| !is_command_only_actionable(item) && scrub(item, allowlist));
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
                // A WorkspaceEdit is an all-or-nothing protocol contract, so its three
                // spellings are never internally filtered: any out-of-root target marks
                // the WHOLE containing object dirty. A bad code action then drops from
                // its array whole, and a bad rename response nulls whole (see
                // filter_server_message), never applying a subset that would leave the
                // editor and the server disagreeing about the workspace.
                //   - `edit`: a WorkspaceEdit nested in a code action;
                //   - `changes`: the map-keyed-by-URI spelling;
                //   - `documentChanges`: the ordered array spelling (TextDocumentEdits
                //     plus create/rename/delete file operations).
                if key == "edit" || key == "documentChanges" {
                    if first_denied_uri(child, allowlist).is_some() {
                        clean = false;
                    }
                    continue;
                }
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

/// A command payload under a `command` key: either a `Command` object or a plain
/// command-identifier string.
fn is_command_payload(value: &Value) -> bool {
    value.is_string() || (value.is_object() && value.get("command").is_some_and(Value::is_string))
}

/// Whether an array entry is an **inert command-only actionable** (a code action or code
/// lens whose only effect was a command) that must be dropped WHOLE once commands are
/// denied (ADR-0102 D-G), rather than stripped down to a dead `{ title: ... }` husk. It has
/// a command payload, no `edit` and no `data` left to do work, and is an action/lens (has a
/// `title` or a `range`), not a completion item (which carries a `label` and keeps working
/// with its command stripped).
fn is_command_only_actionable(value: &Value) -> bool {
    let Value::Object(map) = value else {
        return false;
    };
    map.get("command").is_some_and(is_command_payload)
        && !map.contains_key("edit")
        && !map.contains_key("data")
        && map.get("label").is_none()
        && (map.contains_key("title") || map.contains_key("range"))
}

/// Whether a URI may cross the wire, SERVER to client: a local `file:` URI must resolve
/// inside an allowlisted root; a `file:` URI with a non-local authority (`file://host/...`)
/// is refused (never probed); a non-`file:` URI (e.g. an `https:` DocumentLink target the
/// operator may click, or a `vscode-*:` internal scheme) carries no filesystem authority
/// and passes.
fn uri_allowed(uri: &str, allowlist: &WorkspaceAllowlist) -> bool {
    match classify_file_uri(uri) {
        FileUriClass::NotFile => true,
        FileUriClass::NonLocalAuthority => false,
        FileUriClass::Local(path) => path_allowed(&path, allowlist),
    }
}

/// Whether a URI may cross the wire, CLIENT to server, in a workspace/document field
/// (`rootUri`, `workspaceFolders`, `textDocument.uri`, edit targets). Stricter than
/// [`uri_allowed`]: a local `file:` URI must be in-root, an `untitled:` unsaved-buffer URI
/// is permitted (a legitimate editor shape with no filesystem authority), and every other
/// scheme (`http:` / `https:` / a non-local `file:` authority / ...) is refused, since a
/// workspace or document field has no business naming a remote resource for the server.
fn client_uri_allowed(uri: &str, allowlist: &WorkspaceAllowlist) -> bool {
    match classify_file_uri(uri) {
        FileUriClass::Local(path) => path_allowed(&path, allowlist),
        FileUriClass::NonLocalAuthority => false,
        FileUriClass::NotFile => uri.starts_with("untitled:"),
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

/// The classification of a URI for boundary purposes.
enum FileUriClass {
    /// Not a `file:` URI (a non-file scheme with no filesystem authority).
    NotFile,
    /// A `file:` URI with a non-local authority (`file://host/share/...`). It is DENIED
    /// outright and never converted to a UNC path or filesystem-probed, because probing
    /// `\\host\...` on Windows triggers SMB network access and can leak NTLM credentials to
    /// a hostile, server-controlled host during validation (ADR-0102 D-G).
    NonLocalAuthority,
    /// A local `file:` URI resolved to a filesystem path.
    Local(PathBuf),
}

/// Classify a URI: not-a-file, a denied non-local `file:` authority, or a local file path.
/// A non-local authority is detected and rejected BEFORE any percent-decoding of the path
/// or filesystem probe, so a hostile `file://host/...` can never induce a network access.
fn classify_file_uri(uri: &str) -> FileUriClass {
    // Byte-prefix check: a multibyte first char must never panic a str slice. "file://"
    // is 7 ASCII bytes, so index 7 is a guaranteed char boundary once the prefix matches.
    let bytes = uri.as_bytes();
    if bytes.len() < 7 || !bytes[..7].eq_ignore_ascii_case(b"file://") {
        return FileUriClass::NotFile;
    }
    let rest = &uri[7..];
    let (authority, encoded_path) = match rest.find('/') {
        Some(0) => ("", rest),
        Some(slash) => (&rest[..slash], &rest[slash..]),
        None => (rest, ""),
    };
    // A non-empty, non-localhost authority is a UNC / remote host: deny it here, before
    // building `\\host\...` or probing it.
    if !authority.is_empty() && !authority.eq_ignore_ascii_case("localhost") {
        return FileUriClass::NonLocalAuthority;
    }
    let decoded = percent_decode(encoded_path);
    let decoded_bytes = decoded.as_bytes();
    if decoded_bytes.len() >= 3
        && decoded_bytes[0] == b'/'
        && decoded_bytes[1].is_ascii_alphabetic()
        && decoded_bytes[2] == b':'
    {
        // "/c:/dir" (or "/c%3A/dir") spells a Windows drive path behind a leading slash.
        return FileUriClass::Local(PathBuf::from(&decoded[1..]));
    }
    FileUriClass::Local(PathBuf::from(decoded))
}

/// The local filesystem path a `file:` URI names, or `None` for a non-file URI OR a denied
/// non-local (`file://host/...`) authority. Test-only convenience over [`classify_file_uri`];
/// production boundary checks use `classify_file_uri` directly so they can distinguish "not
/// a file" from "denied file authority".
#[cfg(test)]
fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    match classify_file_uri(uri) {
        FileUriClass::Local(path) => Some(path),
        _ => None,
    }
}

/// Percent-decode a URI path component (bytes, then lossy UTF-8). Operates entirely on
/// bytes so a malformed or non-ASCII `%` sequence (e.g. `%` before a multibyte char) can
/// never panic a str slice at a non-char-boundary; an invalid escape is passed through
/// literally.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[index + 1]), hex_digit(bytes[index + 2]))
            {
                out.push(hi * 16 + lo);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Value of one ASCII hex digit byte (0-9, a-f, A-F), or `None` for any other byte.
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn malformed_and_non_ascii_uris_never_panic() {
        // Regression: the prefix check and percent decoder must operate on bytes so a
        // multibyte char or a truncated/invalid % escape can never slice a &str at a
        // non-char-boundary (which would panic the LSP task and wedge the channel).
        //
        // A multibyte char inside the first 7 bytes (would have panicked `uri[..7]`).
        assert_eq!(file_uri_to_path("fil\u{00e9}://x"), None);
        assert_eq!(file_uri_to_path("\u{1f600}\u{1f600}"), None);
        // A `%` immediately before a multibyte char (would have panicked the str slice).
        assert_eq!(
            file_uri_to_path("file:///home/%\u{00e9}oleg/lib.rs"),
            Some(PathBuf::from("/home/%\u{00e9}oleg/lib.rs"))
        );
        // A truncated escape at end of input, and a non-hex escape, pass through literally.
        assert_eq!(percent_decode("abc%"), "abc%".to_string());
        assert_eq!(percent_decode("abc%2"), "abc%2".to_string());
        assert_eq!(percent_decode("a%ZZb"), "a%ZZb".to_string());
        assert_eq!(percent_decode("%41%42"), "AB".to_string());
        // A percent escape decoding to bytes that form a multibyte char round-trips.
        assert_eq!(percent_decode("%C3%A9"), "\u{00e9}".to_string());
    }

    #[test]
    fn non_local_file_authorities_are_denied_without_probing() {
        let (allowlist, _, _) = boundary_fixture();
        // A `file://host/share/...` (UNC / remote authority) is refused in BOTH directions
        // and never converted to `\\host\...` or filesystem-probed, which on Windows would
        // trigger SMB access and leak NTLM credentials to the server-controlled host.
        let unc = "file://evil-host/share/secret";
        assert!(matches!(
            classify_file_uri(unc),
            FileUriClass::NonLocalAuthority
        ));
        assert!(!uri_allowed(unc, &allowlist)); // server -> client: refused
        assert!(!client_uri_allowed(unc, &allowlist)); // client -> server: refused
        assert_eq!(file_uri_to_path(unc), None); // yields no local path (never probed)
                                                 // Empty and localhost authorities remain local.
        assert!(matches!(
            classify_file_uri("file:///home/x"),
            FileUriClass::Local(_)
        ));
        assert!(matches!(
            classify_file_uri("file://localhost/home/x"),
            FileUriClass::Local(_)
        ));
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
    fn client_uri_fields_permit_only_in_root_file_and_untitled_schemes() {
        let (allowlist, _, _) = boundary_fixture();
        // An `untitled:` unsaved-buffer document is a legitimate editor shape and passes.
        let mut untitled = serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": "untitled:Untitled-1", "text": "x" } }
        });
        assert!(sanitize_client_message(&mut untitled, &allowlist).is_ok());

        // An `https:` (or any non-file, non-untitled) URI in a document field is refused:
        // a workspace/document field has no business naming a remote resource.
        let mut remote = serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": "https://evil.example/x", "text": "x" } }
        });
        let error = sanitize_client_message(&mut remote, &allowlist).expect_err("must refuse");
        assert_eq!(error.code, "lsp_uri_denied");
        // Same for a non-file rootUri at initialize.
        let mut init = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "rootUri": "https://evil.example", "capabilities": {} }
        });
        assert!(sanitize_client_message(&mut init, &allowlist).is_err());
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

        // A relative `rootPath` must not slip past the URI walk (which only sees schemed
        // URIs): it is stripped outright on initialize, so it can never steer the server's
        // workspace root outside the allowlist.
        let mut relative_root = serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "initialize",
            "params": { "rootPath": "../outside", "rootUri": inside, "capabilities": {} }
        });
        assert!(sanitize_client_message(&mut relative_root, &allowlist).is_ok());
        assert!(relative_root.pointer("/params/rootPath").is_none());

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

        // showDocument is answered CENTRALLY (host, once) and never forwarded; v1 does not
        // auto-open server-requested documents, so both external and in-root targets get
        // success: false rather than a broadcast that multiple cockpits would each answer.
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
            ServerFrameAction::Reply(_)
        ));
    }

    #[test]
    fn document_link_targets_are_filtered_to_allowlisted_roots() {
        let (allowlist, inside, outside) = boundary_fixture();
        // A textDocument/documentLink response: each link's `target` is a DocumentUri.
        // An out-of-root target is dropped so go-to-link cannot escape the allowlist.
        let response = serde_json::json!({
            "jsonrpc": "2.0", "id": 20,
            "result": [
                { "range": {}, "target": inside },
                { "range": {}, "target": outside }
            ]
        });
        let ServerFrameAction::Forward(filtered) = filter_server_message(response, &allowlist)
        else {
            panic!("expected Forward");
        };
        let links = filtered
            .get("result")
            .and_then(Value::as_array)
            .expect("array");
        assert_eq!(links.len(), 1);
        assert_eq!(
            links[0].get("target").and_then(Value::as_str),
            Some(inside.as_str())
        );
    }

    #[test]
    fn server_requests_are_answered_centrally_never_forwarded() {
        let (allowlist, _, _) = boundary_fixture();
        // A device-wide broadcast would make every cockpit answer one server request with
        // the same id (duplicate/conflicting responses). The host answers each request
        // ONCE and never forwards it. registerCapability + an arbitrary server request get
        // a generic accept (null); configuration gets host-owned null items.
        let register = serde_json::json!({
            "jsonrpc": "2.0", "id": 21, "method": "client/registerCapability",
            "params": { "registrations": [ {
                "id": "r1", "method": "workspace/didChangeWatchedFiles",
                "registerOptions": { "watchers": [ { "globPattern": "/etc/**/*.conf" } ] }
            } ] }
        });
        let ServerFrameAction::Reply(reply) = filter_server_message(register, &allowlist) else {
            panic!("expected Reply (answered centrally), never Forward");
        };
        assert_eq!(reply.get("id"), Some(&serde_json::json!(21)));
        assert_eq!(reply.get("result"), Some(&Value::Null));

        let config = serde_json::json!({
            "jsonrpc": "2.0", "id": 22, "method": "workspace/configuration",
            "params": { "items": [ { "section": "rust-analyzer" }, { "section": "files" } ] }
        });
        let ServerFrameAction::Reply(reply) = filter_server_message(config, &allowlist) else {
            panic!("expected Reply");
        };
        assert_eq!(reply.get("result"), Some(&serde_json::json!([null, null])));

        // A generic server request (workDoneProgress/create) also gets a null accept.
        let progress = serde_json::json!({
            "jsonrpc": "2.0", "id": 23, "method": "window/workDoneProgress/create",
            "params": { "token": "t1" }
        });
        assert!(matches!(
            filter_server_message(progress, &allowlist),
            ServerFrameAction::Reply(_)
        ));
    }

    #[test]
    fn command_only_code_actions_are_dropped_whole_completions_survive() {
        let (allowlist, inside, _) = boundary_fixture();
        // A codeAction RESPONSE array: a command-only action (title + command, no edit) is
        // dropped whole (not left as an inert { title }); an edit-bearing action keeps its
        // edit and loses its command; a completion-shaped item (has `label`) keeps working.
        let response = serde_json::json!({
            "jsonrpc": "2.0", "id": 30,
            "result": [
                { "title": "Run", "command": { "title": "Run", "command": "server.run" } },
                { "title": "Fix", "edit": { "changes": { (inside.clone()): [] } },
                  "command": "server.fix" },
                { "label": "foo", "command": { "command": "server.after" } }
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
        assert_eq!(result.len(), 2); // the command-only action is gone
        assert_eq!(result[0].get("title").and_then(Value::as_str), Some("Fix"));
        assert!(result[0].get("edit").is_some());
        assert!(result[0].get("command").is_none());
        // The completion item survives (kept by its label), command stripped.
        assert_eq!(result[1].get("label").and_then(Value::as_str), Some("foo"));
        assert!(result[1].get("command").is_none());
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
    fn a_document_changes_edit_is_atomic_never_partially_filtered() {
        let (allowlist, inside, outside) = boundary_fixture();
        // The documentChanges spelling of a WorkspaceEdit (ordered TextDocumentEdits) is
        // the same all-or-nothing contract: one out-of-root target nulls the WHOLE rename
        // response; the in-root subset must never survive on its own (a partial edit set
        // would leave the editor and the server disagreeing about the workspace).
        let dirty = serde_json::json!({
            "jsonrpc": "2.0", "id": 8,
            "result": { "documentChanges": [
                { "textDocument": { "uri": inside, "version": 3 },
                  "edits": [ { "newText": "x", "range": {} } ] },
                { "textDocument": { "uri": outside, "version": 1 },
                  "edits": [ { "newText": "y", "range": {} } ] }
            ] }
        });
        let ServerFrameAction::Forward(filtered) = filter_server_message(dirty, &allowlist) else {
            panic!("expected Forward");
        };
        assert!(filtered.get("result").expect("result").is_null());

        // A fully in-root documentChanges edit forwards intact, both entries preserved.
        let clean = serde_json::json!({
            "jsonrpc": "2.0", "id": 9,
            "result": { "documentChanges": [
                { "textDocument": { "uri": inside.clone(), "version": 3 },
                  "edits": [ { "newText": "x", "range": {} } ] },
                { "textDocument": { "uri": inside, "version": 3 },
                  "edits": [ { "newText": "z", "range": {} } ] }
            ] }
        });
        let ServerFrameAction::Forward(forwarded) = filter_server_message(clean, &allowlist) else {
            panic!("expected Forward");
        };
        let entries = forwarded
            .pointer("/result/documentChanges")
            .and_then(Value::as_array)
            .expect("documentChanges");
        assert_eq!(entries.len(), 2);
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
