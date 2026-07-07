//! Project launch (ADR-0104): host-owned repo-type detection that resolves named launch
//! targets, plus the supervised, long-lived subprocess that runs one.
//!
//! This is the process-execution sibling of the ADR-0103 terminal and the long-lived cousin of
//! the ADR-0096 one-shot check runner. It inherits the ADR-0103 D9 Supervised Exec Posture and
//! records ONE delta (D3): a launch is mobile-safe (relay-reachable), because the host, not the
//! wire, chooses the program. The client picks a detected target **id**; it never supplies a
//! command line (D1). An unknown id resolves to nothing and is denied. The resolved argv is
//! spawned directly via `std::process::Command` with no shell (inheriting ADR-0096 D3).
//!
//! Detection is a read over an allowlisted root (ADR-0104 D1). The supervised child runs in its
//! own process group and is tree-killed on stop / disconnect / token-revoke / root-removal
//! (ADR-0104 D2, reusing the ADR-0096/0103 supervised-spawn shape). Output streams live to the
//! owning session and is never persisted (ADR-0090 D11).

use crate::adapter::BridgeError;
use crate::adapters::child_run::{kill_process_tree, put_in_own_process_group};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};

/// One inbound read from a launched process's stdout/stderr.
const LAUNCH_READ_CHUNK: usize = 8192;

/// Which kind of target a detected launch represents, a hint for the cockpit picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchKind {
    Run,
    Build,
    Test,
    /// A repository-declared script (e.g. a `package.json` script whose body the repo owns).
    Script,
}

/// One host-detected launch target. `id`, `label`, and `kind` cross the wire so the cockpit can
/// offer a picker; `program` and `args` are host-owned resolution and NEVER serialized (D1: the
/// client picks the id, the host owns what it runs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTarget {
    pub id: String,
    pub label: String,
    pub kind: LaunchKind,
    #[serde(skip)]
    program: String,
    #[serde(skip)]
    args: Vec<String>,
}

impl LaunchTarget {
    fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        kind: LaunchKind,
        program: impl Into<String>,
        args: Vec<String>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            kind,
            program: program.into(),
            args,
        }
    }
}

/// Detect the launch targets an allowlisted `root` implies, from the host-owned
/// detector-and-resolution table (ADR-0104 D1). A read over the root, so it needs no exec
/// boundary of its own; only the launch it enables is the sanctioned exception. Returns an
/// empty list for a repo whose type the table does not yet cover (the operator adds a detector
/// row or uses the desktop terminal; launch never falls back to a free command).
pub fn detect_targets(root: &str) -> Vec<LaunchTarget> {
    let dir = Path::new(root);
    let mut targets = Vec::new();

    // .NET: `dotnet build` / `dotnet test` resolve against a solution or any project, but
    // `dotnet run` needs an UNAMBIGUOUS single runnable project. A `.sln` or multiple `.csproj`
    // makes `dotnet run` fail-or-ambiguous, so it is offered only when there is exactly one
    // `.csproj` and no solution; the operator reaches a specific project another way otherwise.
    let has_sln = has_ext(dir, "sln");
    let csproj_count = count_ext(dir, "csproj");
    if has_sln || csproj_count > 0 {
        if !has_sln && csproj_count == 1 {
            targets.push(LaunchTarget::new(
                "dotnet:run",
                "dotnet run",
                LaunchKind::Run,
                "dotnet",
                vec!["run".to_string()],
            ));
        }
        targets.push(LaunchTarget::new(
            "dotnet:build",
            "dotnet build",
            LaunchKind::Build,
            "dotnet",
            vec!["build".to_string()],
        ));
        targets.push(LaunchTarget::new(
            "dotnet:test",
            "dotnet test",
            LaunchKind::Test,
            "dotnet",
            vec!["test".to_string()],
        ));
    }

    // Node: enumerate the scripts the repository ITSELF declares in package.json. The host reads
    // the declared scripts; it does not invent them (D1).
    if let Ok(contents) = std::fs::read_to_string(dir.join("package.json")) {
        for script in node_scripts(&contents) {
            targets.push(LaunchTarget::new(
                format!("node:{script}"),
                format!("npm run {script}"),
                node_script_kind(&script),
                npm_program(),
                vec!["run".to_string(), script],
            ));
        }
    }

    // Rust: a manifest resolves to cargo run/build/test.
    if dir.join("Cargo.toml").is_file() {
        targets.push(LaunchTarget::new(
            "cargo:run",
            "cargo run",
            LaunchKind::Run,
            "cargo",
            vec!["run".to_string()],
        ));
        targets.push(LaunchTarget::new(
            "cargo:build",
            "cargo build",
            LaunchKind::Build,
            "cargo",
            vec!["build".to_string()],
        ));
        targets.push(LaunchTarget::new(
            "cargo:test",
            "cargo test",
            LaunchKind::Test,
            "cargo",
            vec!["test".to_string()],
        ));
    }

    targets
}

/// Resolve a client-supplied target `id` against a fresh detection of `root` (D1: host-owned
/// resolution). `None` for an unknown or unoffered id, which the host denies rather than
/// running anything the client named directly.
pub fn resolve_target(root: &str, id: &str) -> Option<LaunchTarget> {
    detect_targets(root)
        .into_iter()
        .find(|target| target.id == id)
}

/// True when `dir` directly contains any file with extension `ext` (case-insensitive).
fn has_ext(dir: &Path, ext: &str) -> bool {
    count_ext(dir, ext) > 0
}

/// Count files in `dir` (non-recursive) with extension `ext` (case-insensitive).
fn count_ext(dir: &Path, ext: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(ext))
        })
        .count()
}

/// Parse the declared script NAMES out of a `package.json` body. Names only; the host resolves
/// each to `npm run <name>` and never reads the script body as a command (D1).
fn node_scripts(package_json: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(package_json) else {
        return Vec::new();
    };
    let Some(scripts) = value.get("scripts").and_then(|scripts| scripts.as_object()) else {
        return Vec::new();
    };
    let mut names: Vec<String> = scripts.keys().cloned().collect();
    names.sort();
    names
}

/// Classify a well-known script name so the picker can badge it; anything else is a `Script`.
fn node_script_kind(name: &str) -> LaunchKind {
    match name {
        "dev" | "start" | "serve" => LaunchKind::Run,
        "build" => LaunchKind::Build,
        "test" => LaunchKind::Test,
        _ => LaunchKind::Script,
    }
}

/// The npm program name for the host platform (`npm.cmd` on Windows, where the launcher is a
/// batch shim resolved through `PATHEXT`).
fn npm_program() -> &'static str {
    #[cfg(windows)]
    {
        "npm.cmd"
    }
    #[cfg(not(windows))]
    {
        "npm"
    }
}

/// Remove obviously-secret-bearing environment variables from a to-be-spawned launch, as
/// defense-in-depth (ADR-0104 D2 honest boundedness). A launch inherits the operator's own
/// environment by design (property 6: no privilege beyond the operator), but its output is
/// streamed device-wide including to relay cockpits, so a variable a repository script might echo
/// must not carry a host-held secret off-box. PATH / HOME / language config survive; only names
/// matching a secret pattern are dropped.
fn scrub_sensitive_env(command: &mut Command) {
    for (name, _) in std::env::vars_os() {
        if let Some(name) = name.to_str() {
            if is_sensitive_env_name(name) {
                command.env_remove(name);
            }
        }
    }
}

/// True for an environment variable name that likely holds a secret (case-insensitive substring).
fn is_sensitive_env_name(name: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "PASSWD",
        "CONNECTION_STRING",
        "PRIVATE_KEY",
        "API_KEY",
        "ACCESS_KEY",
        "CREDENTIAL",
    ];
    let upper = name.to_ascii_uppercase();
    NEEDLES.iter().any(|needle| upper.contains(needle))
}

/// Which output stream a launch chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchStream {
    Stdout,
    Stderr,
}

/// One chunk of a launched process's output, tagged with its stream.
pub struct LaunchChunk {
    pub stream: LaunchStream,
    pub data: Vec<u8>,
}

/// A live, supervised launch: the child process (in its own group), its pid, and the reader
/// threads draining stdout/stderr into a channel. Tree-killed exactly once (ADR-0104 D2).
pub struct LaunchSession {
    child: std::process::Child,
    process_id: u32,
    killed: bool,
}

impl Drop for LaunchSession {
    fn drop(&mut self) {
        self.kill();
    }
}

impl LaunchSession {
    /// Spawn a resolved `target` in `cwd` (an allowlisted root the host already gated). Returns
    /// the session plus a receiver of every output chunk. Direct `std::process::Command`, no
    /// shell (D1); the child leads its own process group so the whole tree is killable (D2).
    pub fn spawn(
        target: &LaunchTarget,
        cwd: &str,
    ) -> Result<(Self, Receiver<LaunchChunk>), BridgeError> {
        let mut command = Command::new(&target.program);
        command
            .args(&target.args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        scrub_sensitive_env(&mut command);
        put_in_own_process_group(&mut command);
        // Audit line (ADR-0104 D7): every launch is host-logged with the resolved target and
        // project root, so a launch is traceable from the bridge console.
        eprintln!(
            "[launch] {} -> {} {} in {cwd}",
            target.id,
            target.program,
            target.args.join(" ")
        );
        let mut child = command.spawn().map_err(|error| {
            BridgeError::new(
                "launch_spawn_failed",
                format!("could not launch '{}': {error}", target.label),
            )
        })?;
        let process_id = child.id();

        let (sender, receiver) = channel::<LaunchChunk>();
        if let Some(stdout) = child.stdout.take() {
            spawn_reader(stdout, LaunchStream::Stdout, sender.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_reader(stderr, LaunchStream::Stderr, sender);
        }

        Ok((
            Self {
                child,
                process_id,
                killed: false,
            },
            receiver,
        ))
    }

    /// The launched process's OS pid.
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Observe exit without blocking. `None` while the process runs; `Some(code)` once it has
    /// exited, where `code` is the process exit code (`None` when it was killed by a signal). The
    /// host's launch watchdog polls this so a launch is retired when its PROCESS exits, even if a
    /// descendant still holds an output pipe open (which would otherwise keep the stream channel
    /// alive forever).
    pub fn poll_exit(&mut self) -> Option<Option<i32>> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            _ => None,
        }
    }

    /// Tree-kill the launch (once). Idempotent with `Drop`. Best-effort (ADR-0090 D4 honesty):
    /// `kill_process_tree` walks the process tree by pid (`taskkill /T` on Windows) or signals the
    /// process group (Unix). A descendant that deliberately detaches into its own session or is
    /// re-parented after an intermediate exits can survive, so a long-lived dev server that spawns
    /// a detached worker may leave that worker (and its port) running. A Windows Job Object would
    /// bound the tree reliably and is the noted follow-up.
    pub fn kill(&mut self) {
        if self.killed {
            return;
        }
        self.killed = true;
        kill_process_tree(&mut self.child);
    }
}

/// Drain one output stream to `sender` until EOF (process exit) or a hard read error, one chunk
/// per read. A signal-interrupted read is retried rather than treated as exit.
fn spawn_reader(
    mut source: impl Read + Send + 'static,
    stream: LaunchStream,
    sender: Sender<LaunchChunk>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; LAUNCH_READ_CHUNK];
        loop {
            match source.read(&mut buffer) {
                Ok(0) => return,
                Ok(n) => {
                    let chunk = LaunchChunk {
                        stream,
                        data: buffer[..n].to_vec(),
                    };
                    if sender.send(chunk).is_err() {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_scripts_are_parsed_sorted_and_body_ignored() {
        let package =
            r#"{ "scripts": { "dev": "vite", "build": "tsc && vite build", "test": "vitest" } }"#;
        assert_eq!(node_scripts(package), vec!["build", "dev", "test"]);
    }

    #[test]
    fn node_scripts_tolerates_missing_or_bad_json() {
        assert!(node_scripts("not json").is_empty());
        assert!(node_scripts(r#"{ "name": "x" }"#).is_empty());
    }

    #[test]
    fn sensitive_env_names_are_recognized_case_insensitively() {
        for name in [
            "AZURE_CLIENT_SECRET",
            "GitHub_Token",
            "DB_PASSWORD",
            "APPCONFIG_CONNECTION_STRING",
            "SOME_API_KEY",
        ] {
            assert!(is_sensitive_env_name(name), "{name} should be sensitive");
        }
        for name in [
            "PATH",
            "HOME",
            "NODE_ENV",
            "CARGO_HOME",
            "HONEYHUB_EXTRA_CHECKS",
        ] {
            assert!(
                !is_sensitive_env_name(name),
                "{name} should not be sensitive"
            );
        }
    }

    #[test]
    fn node_script_kind_badges_well_known_names() {
        assert_eq!(node_script_kind("dev"), LaunchKind::Run);
        assert_eq!(node_script_kind("build"), LaunchKind::Build);
        assert_eq!(node_script_kind("test"), LaunchKind::Test);
        assert_eq!(node_script_kind("lint"), LaunchKind::Script);
    }

    #[test]
    fn detect_targets_reads_node_and_cargo_in_a_temp_dir() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("package.json"),
            r#"{ "scripts": { "dev": "vite" } }"#,
        )
        .expect("write package.json");
        std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname=\"x\"")
            .expect("write cargo");
        let root = dir.path().to_string_lossy();
        let targets = detect_targets(&root);
        let ids: Vec<&str> = targets.iter().map(|target| target.id.as_str()).collect();
        assert!(ids.contains(&"node:dev"));
        assert!(ids.contains(&"cargo:run"));
        assert!(ids.contains(&"cargo:build"));
        assert!(ids.contains(&"cargo:test"));
    }

    #[test]
    fn dotnet_run_only_for_a_single_unambiguous_project() {
        // One .csproj, no solution: run + build + test.
        let single = tempfile::tempdir().expect("temp dir");
        std::fs::write(single.path().join("App.csproj"), "<Project/>").expect("write csproj");
        let ids: Vec<String> = detect_targets(&single.path().to_string_lossy())
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert!(ids.contains(&"dotnet:run".to_string()));
        assert!(ids.contains(&"dotnet:build".to_string()));

        // A solution present: run is ambiguous, so only build + test are offered.
        let sln = tempfile::tempdir().expect("temp dir");
        std::fs::write(sln.path().join("App.sln"), "").expect("write sln");
        std::fs::write(sln.path().join("App.csproj"), "<Project/>").expect("write csproj");
        let ids: Vec<String> = detect_targets(&sln.path().to_string_lossy())
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert!(!ids.contains(&"dotnet:run".to_string()));
        assert!(ids.contains(&"dotnet:build".to_string()));
        assert!(ids.contains(&"dotnet:test".to_string()));

        // Multiple projects, no solution: run is still ambiguous.
        let multi = tempfile::tempdir().expect("temp dir");
        std::fs::write(multi.path().join("A.csproj"), "<Project/>").expect("write a");
        std::fs::write(multi.path().join("B.csproj"), "<Project/>").expect("write b");
        let ids: Vec<String> = detect_targets(&multi.path().to_string_lossy())
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert!(!ids.contains(&"dotnet:run".to_string()));
        assert!(ids.contains(&"dotnet:build".to_string()));
    }

    #[test]
    fn resolve_target_denies_unknown_ids() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname=\"x\"")
            .expect("write cargo");
        let root = dir.path().to_string_lossy();
        assert!(resolve_target(&root, "cargo:run").is_some());
        assert!(resolve_target(&root, "cargo:publish").is_none());
        assert!(resolve_target(&root, "rm -rf /").is_none());
    }

    #[test]
    fn launch_target_does_not_serialize_program_or_args() {
        let target = LaunchTarget::new(
            "cargo:run",
            "cargo run",
            LaunchKind::Run,
            "cargo",
            vec!["run".into()],
        );
        let json = serde_json::to_string(&target).expect("serialize");
        assert!(json.contains("cargo:run"));
        assert!(!json.contains("\"program\""));
        assert!(!json.contains("\"args\""));
    }

    #[test]
    fn spawn_streams_output_and_tree_kills() {
        // Launch a trivial process that prints and exits, using the platform's echo shim.
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        #[cfg(windows)]
        let target = LaunchTarget::new(
            "t",
            "t",
            LaunchKind::Run,
            "cmd",
            vec!["/C".into(), "echo".into(), "hh_launch".into()],
        );
        #[cfg(not(windows))]
        let target = LaunchTarget::new(
            "t",
            "t",
            LaunchKind::Run,
            "sh",
            vec!["-c".into(), "echo hh_launch".into()],
        );
        let (mut session, output) = LaunchSession::spawn(&target, &dir).expect("spawn");
        assert!(session.process_id() > 0);

        let mut seen = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match output.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(chunk) => {
                    seen.push_str(&String::from_utf8_lossy(&chunk.data));
                    if seen.contains("hh_launch") {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(
            seen.contains("hh_launch"),
            "expected launched output, saw: {seen:?}"
        );
        session.kill();
        session.kill();
    }
}
