//! Integration test: the LSP proxy spawns a supervised (fake) language server, frames a
//! JSON-RPC request to its stdin, and receives the framed reply back off stdout — proving
//! the Content-Length framed round-trip and the spawn/kill lifecycle end to end. Uses the
//! `fake_lsp` fixture (gated by `test-fixtures`), which echoes each request as a response.

#![cfg(feature = "test-fixtures")]

use std::ffi::OsString;
use std::time::Duration;

use honeyhub_bridge::lsp::LspServer;

fn fake_lsp() -> OsString {
    OsString::from(env!("CARGO_BIN_EXE_fake_lsp"))
}

fn workspace() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

#[test]
fn proxies_a_framed_request_and_receives_the_framed_reply() {
    let (mut server, inbound) =
        LspServer::spawn(fake_lsp(), &[], &workspace(), "fake-lsp").expect("spawn fake lsp");
    assert!(server.process_id() > 0);
    assert_eq!(server.server_id(), "fake-lsp");

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "initialize",
        "params": { "processId": null },
    });
    server
        .write_message(&request)
        .expect("write framed request");

    let response = inbound
        .recv_timeout(Duration::from_secs(5))
        .expect("received the framed reply");
    // The fixture echoes the request id and body, so the framing round-tripped intact.
    assert_eq!(response["jsonrpc"], serde_json::json!("2.0"));
    assert_eq!(response["id"], serde_json::json!(7));
    assert_eq!(
        response["result"]["echo"]["method"],
        serde_json::json!("initialize")
    );

    // A second message reuses the same live server (one server per language/root).
    let second = serde_json::json!({ "jsonrpc": "2.0", "id": 8, "method": "shutdown" });
    server.write_message(&second).expect("write second request");
    let response = inbound
        .recv_timeout(Duration::from_secs(5))
        .expect("received the second reply");
    assert_eq!(response["id"], serde_json::json!(8));

    // Killing the server ends the reader thread; the channel then disconnects.
    server.close_and_kill();
    let ended = loop {
        match inbound.recv_timeout(Duration::from_secs(5)) {
            Ok(_) => continue, // drain any in-flight reply
            Err(_) => break true,
        }
    };
    assert!(
        ended,
        "the inbound channel disconnects once the server is killed"
    );
}

#[test]
fn dropping_the_server_kills_it_and_disconnects_the_channel() {
    let (server, inbound) =
        LspServer::spawn(fake_lsp(), &[], &workspace(), "fake-lsp").expect("spawn fake lsp");
    drop(server);
    // Drop kills the tree + joins the reader, so the channel is disconnected.
    let result = inbound.recv_timeout(Duration::from_secs(5));
    assert!(
        result.is_err(),
        "the channel disconnects once the server is dropped"
    );
}
