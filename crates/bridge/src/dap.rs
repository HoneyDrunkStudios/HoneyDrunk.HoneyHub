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

use crate::backend_catalog::resolve_program;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};

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
