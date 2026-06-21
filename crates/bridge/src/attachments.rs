//! Chat attachments (HoneyHub attachments v1).
//!
//! Files the user attaches to a chat turn (documents, pasted/dropped images) arrive
//! inline (base64) on the [`StartRunRequest`](crate::adapter::StartRunRequest). The
//! runtime writes them to a per-run temp dir and appends their absolute paths to the
//! task, so **every** backend gets attachments the same way: the agent reads the files
//! from disk by path. There is no per-CLI multimodal plumbing — a deliberately
//! backend-agnostic design (the operator chose the universal temp-file approach).
//!
//! The temp dir lives under the OS temp location, **not** the workspace, so attachments
//! never show up as git noise in the user's repo. The spawned CLI is not bound by the
//! bridge's workspace allowlist (that gates the bridge's own file reads), so it can read
//! these absolute paths.

use crate::adapter::{BridgeError, ChatAttachment};
use std::path::PathBuf;

/// The per-run directory attachments are written to:
/// `<temp>/honeyhub/attachments/<run_id>`.
pub fn attachment_dir(run_id: &str) -> PathBuf {
    std::env::temp_dir()
        .join("honeyhub")
        .join("attachments")
        .join(sanitize_name(run_id))
}

/// Decode standard base64 into bytes. Whitespace and `=` padding are skipped, so the
/// caller can pass the raw value the browser produced. Returns the offending character
/// on the first invalid byte. Dependency-free on purpose (the bridge avoids adding
/// crates for small, well-understood routines).
pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in input.as_bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = base64_value(byte)
            .ok_or_else(|| format!("invalid base64 character: {:?}", byte as char))?;
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Reduce an arbitrary client-supplied name to a safe basename: drop any path
/// components (either separator), keep a conservative character set, and never allow an
/// empty or dot-only result (which could escape the dir or be unwritable). Distinct from
/// per-file uniqueness, which the caller adds with an index prefix.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "attachment".to_string()
    } else {
        cleaned
    }
}

/// Write each attachment into the per-run temp dir and return their absolute paths, in
/// order. Each file is prefixed with its index so two attachments that share a name do
/// not collide. An empty list writes nothing and returns an empty vec.
pub fn write_attachments(
    run_id: &str,
    attachments: &[ChatAttachment],
) -> Result<Vec<String>, BridgeError> {
    if attachments.is_empty() {
        return Ok(Vec::new());
    }
    let dir = attachment_dir(run_id);
    std::fs::create_dir_all(&dir).map_err(|error| {
        BridgeError::new(
            "attachment_write_failed",
            format!("could not create attachment directory: {error}"),
        )
    })?;

    let mut paths = Vec::with_capacity(attachments.len());
    for (index, attachment) in attachments.iter().enumerate() {
        let bytes = decode_base64(&attachment.data).map_err(|error| {
            BridgeError::new(
                "attachment_decode_failed",
                format!("attachment {:?}: {error}", attachment.name),
            )
        })?;
        let file_name = format!("{index}-{}", sanitize_name(&attachment.name));
        let path = dir.join(&file_name);
        std::fs::write(&path, &bytes).map_err(|error| {
            BridgeError::new(
                "attachment_write_failed",
                format!("could not write attachment {file_name:?}: {error}"),
            )
        })?;
        paths.push(path.to_string_lossy().to_string());
    }
    Ok(paths)
}

/// Append a short, explicit block listing the attachment paths to the task, so the
/// agent knows to read them. Returns the task unchanged when there are no paths.
pub fn append_attachment_refs(task: &str, paths: &[String]) -> String {
    if paths.is_empty() {
        return task.to_string();
    }
    let mut out = String::from(task);
    out.push_str(
        "\n\nThe user attached the following file(s) for this message. \
Read them from these paths as needed:\n",
    );
    for path in paths {
        out.push_str("- ");
        out.push_str(path);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_base64_with_and_without_padding_and_whitespace() {
        // "hello" -> aGVsbG8=
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        // "hi" -> aGk= ; also tolerate embedded whitespace/newlines and missing padding.
        assert_eq!(decode_base64("aG\nk").unwrap(), b"hi");
        // empty stays empty
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn rejects_invalid_base64_characters() {
        let error = decode_base64("not*valid").expect_err("'*' is not a base64 char");
        assert!(error.contains("invalid base64"));
    }

    #[test]
    fn sanitize_name_strips_paths_and_unsafe_chars() {
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("C:\\Users\\me\\report.pdf"), "report.pdf");
        assert_eq!(sanitize_name("weird name!@#.png"), "weird name___.png");
        assert_eq!(sanitize_name("   "), "attachment");
        assert_eq!(sanitize_name("..."), "attachment");
    }

    #[test]
    fn write_attachments_writes_files_and_returns_paths() {
        let run_id = format!("test-{}", uuid::Uuid::new_v4());
        let attachments = vec![
            ChatAttachment {
                name: "notes.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                data: "aGVsbG8=".to_string(), // "hello"
            },
            // Same name twice: the index prefix keeps them distinct.
            ChatAttachment {
                name: "notes.txt".to_string(),
                mime_type: None,
                data: "aGk=".to_string(), // "hi"
            },
        ];
        let paths = write_attachments(&run_id, &attachments).expect("writes");
        assert_eq!(paths.len(), 2);
        assert_ne!(paths[0], paths[1]);
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"hello");
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"hi");
        assert!(paths[0].ends_with("0-notes.txt"));
        assert!(paths[1].ends_with("1-notes.txt"));

        let _ = std::fs::remove_dir_all(attachment_dir(&run_id));
    }

    #[test]
    fn append_attachment_refs_is_noop_without_paths() {
        assert_eq!(append_attachment_refs("do it", &[]), "do it");
    }

    #[test]
    fn append_attachment_refs_lists_paths() {
        let augmented = append_attachment_refs("do it", &["/tmp/a.png".to_string()]);
        assert!(augmented.starts_with("do it"));
        assert!(augmented.contains("/tmp/a.png"));
        assert!(augmented.contains("attached the following file"));
    }
}
