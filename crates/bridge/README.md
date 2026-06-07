# honeyhub-bridge

Rust local runner bridge for HoneyHub.

The scaffold provides module seams and a compile-time contract skeleton only:

- `session` - run state and session entities.
- `adapter` - `AgentBackendAdapter` trait and capability flags.
- `process` - process handle seam.
- `pairing` - device identity and allowlist seams.
- `artifact` - artifact metadata seam.

Process launch, the wire protocol, pairing, and backend adapters land in Phase 2 packets.
