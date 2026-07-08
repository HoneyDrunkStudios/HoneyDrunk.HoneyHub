//! Content-Length framed JSON-RPC, shared by the LSP (ADR-0102) and DAP (ADR-0106) runners.
//!
//! Both protocols speak the same stdio framing: a `Content-Length: N\r\n\r\n` header followed by
//! an N-byte UTF-8 JSON body. ADR-0106 D2 says the DAP runner "reuses the ADR-0102 runner shape
//! wholesale", so rather than copy the framing into each runner this module owns it once and both
//! `lsp.rs` and `dap.rs` call it. The per-runner reader threads differ only in their message-size
//! cap and their sink, which [`read_frames`] takes as parameters.

use serde_json::Value;
use std::io::{BufRead, Read};

/// Prefix `message` with a `Content-Length` header framing its UTF-8 JSON body.
pub fn frame_message(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_else(|_| b"{}".to_vec());
    let mut framed = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    framed.extend_from_slice(&body);
    framed
}

/// Read headers up to the blank line, returning the `Content-Length`. `None` on EOF or a header
/// block without a length (which ends the reader, so the host observes the subprocess exit).
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

/// Consume exactly `remaining` bytes, discarding them (used to skip an over-cap body while keeping
/// the frame stream in sync).
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

/// Read Content-Length framed messages off `reader` until EOF (subprocess exit) or a malformed
/// frame, handing each parsed message to `sink`. `sink` returns `false` to stop reading (its
/// receiver is gone, e.g. the server/adapter was retired). A body larger than `max_bytes` is
/// drained (to stay framed) then dropped, so a hostile or runaway subprocess cannot force an
/// unbounded allocation.
pub fn read_frames(
    mut reader: impl BufRead,
    max_bytes: usize,
    mut sink: impl FnMut(Value) -> bool,
) {
    loop {
        let Some(len) = read_content_length(&mut reader) else {
            return;
        };
        if len == 0 {
            continue;
        }
        if len > max_bytes {
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
            if !sink(value) {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::BufReader;

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

        let mut empty = BufReader::new(&b""[..]);
        assert_eq!(read_content_length(&mut empty), None);
    }

    #[test]
    fn read_frames_parses_each_message_and_stops_when_the_sink_declines() {
        let mut buffer = frame_message(&json!({ "event": "one" }));
        buffer.extend(frame_message(&json!({ "event": "two" })));
        let mut seen: Vec<String> = Vec::new();
        read_frames(BufReader::new(&buffer[..]), 1024, |value| {
            seen.push(value["event"].as_str().unwrap_or("").to_string());
            // Stop after the first message to prove the sink's `false` ends the loop.
            false
        });
        assert_eq!(seen, ["one"]);
    }

    #[test]
    fn read_frames_drains_an_over_cap_body_but_keeps_the_stream_framed() {
        let mut buffer = frame_message(&json!({ "big": "x".repeat(200) }));
        buffer.extend(frame_message(&json!({ "event": "after" })));
        let mut seen: Vec<String> = Vec::new();
        // A tiny cap drops the first (over-cap) body but the second frame is still read.
        read_frames(BufReader::new(&buffer[..]), 32, |value| {
            if let Some(event) = value["event"].as_str() {
                seen.push(event.to_string());
            }
            true
        });
        assert_eq!(seen, ["after"]);
    }
}
