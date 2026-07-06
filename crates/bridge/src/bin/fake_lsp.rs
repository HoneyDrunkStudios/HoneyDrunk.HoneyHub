//! Test-only fixture: a minimal Content-Length framed "language server" that echoes each
//! LSP JSON-RPC request it receives back as a response, so the bridge's LSP proxy can be
//! driven end to end without a real language server installed. Gated behind the
//! `test-fixtures` feature so it never ships as a product binary (Grid invariant 16).
//!
//! Protocol: read a `Content-Length: N\r\n\r\n<json>` frame from stdin; reply with a
//! framed `{"jsonrpc":"2.0","id":<id>,"result":{"echo":<original>}}` (echoing the request
//! id when present). Exits on stdin EOF.

use std::io::{BufRead, BufReader, Write};

fn main() {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    while let Some(body) = read_frame(&mut reader) {
        let request: serde_json::Value =
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        let id = request
            .get("id")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "echo": request },
        });
        let payload = serde_json::to_vec(&response).expect("encode response");
        let header = format!("Content-Length: {}\r\n\r\n", payload.len());
        if out.write_all(header.as_bytes()).is_err()
            || out.write_all(&payload).is_err()
            || out.flush().is_err()
        {
            break;
        }
    }
}

/// Read one Content-Length framed message body, or `None` on EOF / malformed input.
fn read_frame(reader: &mut impl BufRead) -> Option<Vec<u8>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return None,
            Ok(_) => {}
            Err(_) => return None,
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = rest.trim().parse::<usize>().ok();
        }
    }
    let len = content_length?;
    let mut body = vec![0_u8; len];
    reader.read_exact(&mut body).ok()?;
    Some(body)
}
