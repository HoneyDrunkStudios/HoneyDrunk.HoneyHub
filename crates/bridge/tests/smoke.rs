use honeyhub_bridge::{BridgeIdentity, CapabilityFlags, ProcessHandle, WIRE_PROTOCOL_VERSION};

#[test]
fn bridge_scaffold_exposes_core_seams() {
    let identity = BridgeIdentity::new("dev-machine");
    let handle = ProcessHandle::placeholder("run-1");
    let capabilities = CapabilityFlags::claude_local();

    assert_eq!(identity.display_name, "dev-machine");
    assert_eq!(handle.process_id, None);
    assert!(capabilities.streaming_output);
    assert_eq!(WIRE_PROTOCOL_VERSION, "honeyhub.bridge.v1");
}
