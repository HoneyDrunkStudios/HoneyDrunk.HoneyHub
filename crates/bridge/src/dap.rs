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
use crate::adapters::child_run::kill_process_tree;
use crate::backend_catalog::resolve_program;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Child;
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

/// A host-detected debug configuration the cockpit can pick (ADR-0106 D3 / Amendment 1). ONLY
/// these fields cross the wire: the client selects a `config_id` from a host-provided list and the
/// host owns the debuggee resolution (program / cwd / env). No filesystem path is ever leaked to
/// the client through this, in keeping with the D3 (Firm) host-owned-debuggee boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfig {
    /// Stable selector the client echoes back in `dap_start`. Host-derived by convention.
    pub config_id: String,
    /// Human label for the cockpit picker (e.g. `App (net9.0)`).
    pub label: String,
    /// The language this config debugs (e.g. `csharp`), for the D8 honest capability flag.
    pub language: String,
    /// The host-owned adapter that will debug it (e.g. `netcoredbg`).
    pub adapter_id: String,
}

/// The host-resolved debuggee for a selected config (ADR-0106 D3, Firm). NEVER serialized: the
/// client never learns or supplies the program path, working directory, or environment. It is fed
/// straight into a HOST-originated DAP `launch`; a client `launch` is still refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebugTarget {
    /// The adapter that debugs it (e.g. `netcoredbg`).
    pub adapter_id: String,
    /// Absolute, canonicalized, in-root path to the built debuggee (the .NET assembly `.dll`).
    pub program: PathBuf,
    /// Working directory for the debuggee (the project directory, canonicalized in-root).
    pub cwd: PathBuf,
}

/// A detected config plus the host-only metadata needed to resolve its debuggee. The metadata is
/// never serialized; it stays host-side so `resolve_debug_target` can derive the built assembly.
struct DebugCandidate {
    config: DebugConfig,
    /// The directory holding the project file (v1: the allowlisted root itself).
    project_dir: PathBuf,
    /// The assembly name (`<AssemblyName>` or the project-file stem).
    assembly_name: String,
    /// The target framework moniker this config debugs (e.g. `net9.0`).
    tfm: String,
}

/// Whether an allowlisted adapter id has its binary located on the host (operator-installed).
/// The honest capability filter (ADR-0106 D8): a config is only offered for launch when the
/// adapter that would run it actually exists, so the cockpit never advertises a Debug config that
/// would fail at open with `dap_adapter_not_installed`.
pub fn adapter_installed(adapter_id: &str) -> bool {
    resolve_adapter(adapter_id).is_some_and(|spec| locate(&spec).is_some())
}

/// Detect the debug configurations an allowlisted `root` implies (ADR-0106 Amendment 1:
/// host-derived-by-convention). For the netcoredbg adapter this enumerates the runnable .NET
/// projects at the top of `root` (an app project, one config per target framework); a library
/// project is excluded. Purely a read over the root, like the ADR-0104 launch detector: it owns
/// what a `config_id` resolves to, so the client never supplies a program. An empty list means
/// Debug is unavailable and the cockpit shows Run-only (D8).
pub fn detect_debug_configs(root: &str) -> Vec<DebugConfig> {
    detect_debug_candidates(root)
        .into_iter()
        .map(|candidate| candidate.config)
        .collect()
}

/// Resolve a client-selected `config_id` to a host-owned debuggee (ADR-0106 D3, Firm). Re-detects
/// `root` (host-owned resolution, never trusting a cached client view), derives the built assembly
/// `bin/Debug/<tfm>/<assembly>.dll`, and validates it: it must canonicalize INSIDE the root (a
/// `..`/symlink escape is refused) and be an existing regular file. A config the host does not
/// offer is `dap_config_unknown`; a project that has not been built yet is `dap_target_not_built`
/// (the host does not build it, ADR-0106 Amendment 1). The returned target is never serialized.
pub fn resolve_debug_target(root: &str, config_id: &str) -> Result<DebugTarget, BridgeError> {
    let candidate = detect_debug_candidates(root)
        .into_iter()
        .find(|candidate| candidate.config.config_id == config_id)
        .ok_or_else(|| {
            BridgeError::new(
                "dap_config_unknown",
                "no host-owned debug configuration matches that id",
            )
        })?;

    // The built assembly, by the standard SDK output convention. Configuration is Debug (this is a
    // debug launch); the host does not accept a client-chosen configuration.
    let relative = Path::new("bin")
        .join("Debug")
        .join(&candidate.tfm)
        .join(format!("{}.dll", candidate.assembly_name));
    let expected = candidate.project_dir.join(&relative);

    // Containment is checked against the canonicalized root. `canonicalize` also requires the path
    // to exist, so a not-yet-built assembly fails here with the honest "not built" reason. The
    // message names only the ROOT-RELATIVE expected path (never the absolute build path, which
    // would leak the host filesystem layout to the client).
    let canonical_root = Path::new(root).canonicalize().map_err(|_| {
        BridgeError::new(
            "dap_root_unavailable",
            "the workspace root could not be resolved",
        )
    })?;
    let canonical_program = expected.canonicalize().map_err(|_| {
        BridgeError::new(
            "dap_target_not_built",
            format!(
                "the debuggee is not built yet; expected {} (build the project in Debug first)",
                relative.to_string_lossy()
            ),
        )
    })?;
    // Refuse a resolved program that escapes the root (a symlink in bin/ pointing outside, a `..`
    // in a crafted assembly name). D3: the debuggee is always in-root.
    if !canonical_program.starts_with(&canonical_root) {
        return Err(BridgeError::new(
            "dap_target_escape",
            "the resolved debuggee is outside the workspace root",
        ));
    }
    if !canonical_program.is_file() {
        return Err(BridgeError::new(
            "dap_target_not_built",
            "the resolved debuggee path is not a regular file",
        ));
    }
    let cwd = candidate
        .project_dir
        .canonicalize()
        .unwrap_or(candidate.project_dir);
    Ok(DebugTarget {
        adapter_id: candidate.config.adapter_id,
        program: canonical_program,
        cwd,
    })
}

/// Re-assert, at LAUNCH time, that a previously-resolved debuggee `program` is still a regular
/// file inside `root` (ADR-0106 D3). [`resolve_debug_target`] validates the program at session
/// open, but the client's `launch` frame can arrive much later, so the workspace could have swapped
/// the built assembly for a symlink pointing outside the root in between (a TOCTOU window). Calling
/// this immediately before the host-owned launch closes that window: it re-canonicalizes (resolving
/// any freshly-planted symlink) and re-checks containment + regular-file, failing closed.
pub fn assert_target_in_root(program: &Path, root: &str) -> Result<(), BridgeError> {
    let canonical_root = Path::new(root).canonicalize().map_err(|_| {
        BridgeError::new(
            "dap_root_unavailable",
            "the workspace root could not be resolved",
        )
    })?;
    let canonical_program = program.canonicalize().map_err(|_| {
        BridgeError::new(
            "dap_target_not_built",
            "the debuggee is no longer present; rebuild before launching",
        )
    })?;
    if !canonical_program.starts_with(&canonical_root) {
        return Err(BridgeError::new(
            "dap_target_escape",
            "the resolved debuggee is outside the workspace root",
        ));
    }
    if !canonical_program.is_file() {
        return Err(BridgeError::new(
            "dap_target_not_built",
            "the resolved debuggee path is not a regular file",
        ));
    }
    Ok(())
}

/// Enumerate the debug candidates under `root`. v1 covers netcoredbg / .NET: the runnable
/// top-level `.csproj` projects, one candidate per target framework. A library project (no
/// `Exe` output and not a Web SDK) is skipped. Nested projects (under a `.sln` in subdirectories)
/// are a follow-up; the ADR-0104 launch detector is likewise top-level.
fn detect_debug_candidates(root: &str) -> Vec<DebugCandidate> {
    let dir = Path::new(root);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    let mut projects: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("csproj"))
        })
        .collect();
    // Deterministic order so the picker and the config ids are stable across detections.
    projects.sort();

    for project in projects {
        let Ok(xml) = std::fs::read_to_string(&project) else {
            continue;
        };
        if !is_runnable_project(&xml) {
            continue;
        }
        let stem = project
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("app")
            .to_string();
        let assembly_name = csproj_value(&xml, "AssemblyName").unwrap_or_else(|| stem.clone());
        let tfms = target_frameworks(&xml);
        let single_tfm = tfms.len() == 1;
        for tfm in tfms {
            // One config per (project, tfm). The id is stable and carries no filesystem path.
            let config_id = if single_tfm {
                format!("dotnet:{stem}")
            } else {
                format!("dotnet:{stem}:{tfm}")
            };
            let label = format!("{stem} ({tfm})");
            candidates.push(DebugCandidate {
                config: DebugConfig {
                    config_id,
                    label,
                    language: "csharp".to_string(),
                    adapter_id: "netcoredbg".to_string(),
                },
                project_dir: dir.to_path_buf(),
                assembly_name: assembly_name.clone(),
                tfm,
            });
        }
    }
    candidates
}

/// Whether a `.csproj` describes a runnable app (an `Exe` output, or a Web SDK which produces a
/// runnable host), as opposed to a library. Parsing is best-effort and dependency-free: it only
/// decides whether to OFFER a config; the real safety gate is that the built assembly must exist
/// in-root at resolve time, so a mis-parse can only cost a missing or spurious picker entry, never
/// a launch of the wrong program.
fn is_runnable_project(xml: &str) -> bool {
    if csproj_value(xml, "OutputType").is_some_and(|value| value.eq_ignore_ascii_case("Exe")) {
        return true;
    }
    // `<Project Sdk="Microsoft.NET.Sdk.Web">` (or Worker) produces a runnable host without an
    // explicit OutputType.
    project_sdk(xml).is_some_and(|sdk| {
        let sdk = sdk.to_ascii_lowercase();
        sdk.contains(".web") || sdk.contains(".worker")
    })
}

/// The inner text of the first `<Tag>...</Tag>` in a project file (case-insensitive tag, trimmed),
/// or `None`. Dependency-free and deliberately simple: csproj property elements are flat text.
fn csproj_value(xml: &str, tag: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{}>", tag.to_ascii_lowercase());
    let close = format!("</{}>", tag.to_ascii_lowercase());
    let start = lower.find(&open)? + open.len();
    let end = lower[start..].find(&close)? + start;
    let value = xml.get(start..end)?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// The `Sdk="..."` attribute of the `<Project>` element, if present.
fn project_sdk(xml: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let attr = lower.find("sdk=\"")? + "sdk=\"".len();
    let rest = xml.get(attr..)?;
    let end = rest.find('"')?;
    let value = rest.get(..end)?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// The target frameworks a project declares: `<TargetFramework>` (one) or `<TargetFrameworks>`
/// (semicolon-separated). Returns an EMPTY list when neither is present, so the project yields no
/// debug config (the host never guesses a framework, which would resolve a wrong assembly path).
fn target_frameworks(xml: &str) -> Vec<String> {
    if let Some(single) = csproj_value(xml, "TargetFramework") {
        return vec![single];
    }
    if let Some(multi) = csproj_value(xml, "TargetFrameworks") {
        let list: Vec<String> = multi
            .split(';')
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        if !list.is_empty() {
            return list;
        }
    }
    Vec::new()
}

/// Upper bound on a single inbound DAP message body, so a hostile or wedged adapter cannot
/// force an unbounded allocation. DAP messages (stack traces, variable trees) are far below
/// this; an over-cap body is consumed to stay framed, then dropped. The Content-Length framing
/// itself is shared with the LSP runner (see [`crate::framing`]).
pub const MAX_DAP_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

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
        let adapter_id = adapter_id.into();
        let display = program.to_string_lossy().into_owned();
        // Own process group so a later tree-kill takes the adapter AND any debuggee it launches;
        // piped stdio; shared with the LSP runner (ADR-0106 D2).
        let (child, stdin, stdout, stderr) =
            crate::framing::spawn_child_in_group(&program, args, root).map_err(|error| {
                BridgeError::new(
                    "dap_spawn_failed",
                    format!("failed to launch debug adapter '{display}': {error}"),
                )
            })?;
        let process_id = child.id();
        // Audit line (ADR-0106 D7): every adapter spawn is host-logged with the root, adapter
        // id, and resolved binary, so a running debug session is traceable from the console.
        eprintln!(
            "[dap] running '{adapter_id}' in {root}: {display} {}",
            args.join(" ")
        );

        // The bounded inbound `sender` backpressures the reader (and thus the adapter's stdout)
        // when the host pump is slow, so a chatty debuggee cannot grow bridge memory without limit.
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Value>(MAX_INBOUND_FRAMES);
        let pumps = crate::framing::spawn_framed_pumps(
            stdin,
            stdout,
            stderr,
            MAX_DAP_MESSAGE_BYTES,
            MAX_QUEUED_OUTBOUND_FRAMES,
            move |value| sender.send(value).is_ok(),
        );
        let writer_tx = pumps.writer_tx;
        let writer = pumps.writer;
        let reader = pumps.reader;

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

    // ---- ADR-0106 D3 / Amendment 1: host-owned debug configuration + debuggee resolution ----

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, body).expect("write file");
    }

    #[test]
    fn detects_a_runnable_dotnet_project_and_skips_a_library() {
        let app = tempfile::tempdir().expect("temp dir");
        write(
            app.path(),
            "App.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
        );
        let configs = detect_debug_configs(&app.path().to_string_lossy());
        assert_eq!(configs.len(), 1, "one runnable app config");
        assert_eq!(configs[0].config_id, "dotnet:App");
        assert_eq!(configs[0].adapter_id, "netcoredbg");
        assert_eq!(configs[0].language, "csharp");
        assert!(configs[0].label.contains("net9.0"));

        // A library project (no Exe output, not a Web SDK) is not offered for debugging.
        let lib = tempfile::tempdir().expect("temp dir");
        write(
            lib.path(),
            "Lib.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
        );
        assert!(
            detect_debug_configs(&lib.path().to_string_lossy()).is_empty(),
            "a library project is not a debug target"
        );
    }

    #[test]
    fn detects_a_web_sdk_project_without_an_explicit_output_type() {
        let web = tempfile::tempdir().expect("temp dir");
        write(
            web.path(),
            "Api.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk.Web\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
        );
        let configs = detect_debug_configs(&web.path().to_string_lossy());
        assert_eq!(configs.len(), 1, "a web host is runnable");
        assert_eq!(configs[0].config_id, "dotnet:Api");
    }

    #[test]
    fn multi_tfm_project_yields_one_config_per_framework() {
        let multi = tempfile::tempdir().expect("temp dir");
        write(
            multi.path(),
            "Multi.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFrameworks>net8.0;net9.0</TargetFrameworks></PropertyGroup></Project>",
        );
        let mut ids: Vec<String> = detect_debug_configs(&multi.path().to_string_lossy())
            .into_iter()
            .map(|config| config.config_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["dotnet:Multi:net8.0", "dotnet:Multi:net9.0"]);
    }

    #[test]
    fn resolves_a_built_assembly_and_reports_not_built_otherwise() {
        let app = tempfile::tempdir().expect("temp dir");
        write(
            app.path(),
            "App.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
        );
        let root = app.path().to_string_lossy().into_owned();

        // Not built yet: denies with a not-built reason that names the ROOT-RELATIVE expected
        // path and never leaks the absolute host build path to the client.
        let err =
            resolve_debug_target(&root, "dotnet:App").expect_err("an unbuilt project is denied");
        assert_eq!(err.code, "dap_target_not_built");
        assert!(
            err.message.contains("bin"),
            "the message names the expected relative build path"
        );
        assert!(
            !err.message.contains(app.path().to_string_lossy().as_ref()),
            "the not-built message must not leak the absolute build path"
        );

        // An unknown config id is denied before any path work.
        assert_eq!(
            resolve_debug_target(&root, "dotnet:Nope")
                .expect_err("unknown id denied")
                .code,
            "dap_config_unknown"
        );

        // Build output present: resolves to the in-root assembly, and never serializes the path.
        write(app.path(), "bin/Debug/net9.0/App.dll", "MZ");
        let target = resolve_debug_target(&root, "dotnet:App").expect("a built project resolves");
        assert_eq!(target.adapter_id, "netcoredbg");
        assert!(target.program.ends_with("App.dll"));
        let canonical_root = app.path().canonicalize().expect("canonical root");
        assert!(
            target.program.starts_with(&canonical_root),
            "the resolved debuggee is inside the root"
        );
    }

    #[test]
    fn uses_the_assembly_name_override_when_present() {
        let app = tempfile::tempdir().expect("temp dir");
        write(
            app.path(),
            "App.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><AssemblyName>Renamed</AssemblyName><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
        );
        let root = app.path().to_string_lossy().into_owned();
        write(app.path(), "bin/Debug/net9.0/Renamed.dll", "MZ");
        let target =
            resolve_debug_target(&root, "dotnet:App").expect("resolves the renamed assembly");
        assert!(target.program.ends_with("Renamed.dll"));
    }

    #[test]
    fn a_traversal_assembly_name_cannot_escape_the_root() {
        // D3 containment: a crafted `<AssemblyName>` with `..` must not resolve the debuggee
        // outside the workspace root, even if a file exists at the escaped location. The
        // canonicalize + starts_with(root) check rejects it.
        let outer = tempfile::tempdir().expect("temp dir");
        let root = outer.path().join("repo");
        std::fs::create_dir_all(&root).expect("root");
        // A real assembly OUTSIDE the root that the traversal would reach.
        std::fs::create_dir_all(outer.path().join("bin/Debug/net9.0")).expect("outer bin");
        std::fs::write(outer.path().join("bin/Debug/net9.0/Pwned.dll"), "MZ").expect("outer dll");
        // The project claims an assembly name that climbs out of the root's bin/ to reach it.
        write(
            &root,
            "App.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><AssemblyName>../../../../bin/Debug/net9.0/Pwned</AssemblyName><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
        );
        let root_str = root.to_string_lossy().into_owned();
        let err = resolve_debug_target(&root_str, "dotnet:App")
            .expect_err("a traversal escape is refused");
        assert!(
            err.code == "dap_target_escape" || err.code == "dap_target_not_built",
            "escape is refused (got {})",
            err.code
        );
    }
}
