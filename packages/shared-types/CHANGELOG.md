# Changelog

## [0.14.0] - 2026-06-08

- Added the `AgentDefinition` type and the `discover_agents` `ClientCommand` (with an optional `workspaceRoot`) + the `agent_catalog` `BridgeEventPayload`, mirroring the bridge's agent-discovery surface.

## [0.13.0] - 2026-06-08

- Added the `coaching_hints` `ClientCommand` (a fieldless query) and the `coaching_hints` `BridgeEventPayload` (a device-scoped event carrying `PolicyHint[]`), mirroring the bridge's cross-session coaching surface.

## [0.12.0] - 2026-06-08

- Added `UsageRollup` and `UsageSummary` (the device-wide "your spend" summary), mirroring the bridge's serde shapes: per-`(backend, fidelity)` rollups with a grounded USD total that excludes estimated spend, plus a separate premium-request total.
- Added the `usage_summary` `ClientCommand` (a fieldless query) and the `usage_summary` `BridgeEventPayload` (the device-scoped summary event).

## [0.11.0] - 2026-06-08

- Added `usage_derived` to `CapabilityFlags` (the third usage shape from the ADR-0090 spike; at most one usage flag set per backend) plus `defaultCodexCapabilities` (resume-based, derived USD) and `defaultCopilotCapabilities` (resume-based, estimated usage) presets, mirroring the Rust adapter capability presets.

## [0.10.0] - 2026-06-08

- Version alignment for the session-diagnostics release (no type changes).

## [0.9.0] - 2026-06-08

- Version alignment for the host auto-open + mobile release (no type changes).

## [0.8.0] - 2026-06-08

- Version alignment for the turnkey-local-cockpit release (no type changes).

## [0.7.0] - 2026-06-07

- Version alignment for the bridge-host transport release (no type changes).

## [0.6.0] - 2026-06-07

- Version alignment for the run-screen release (no type changes).

## [0.5.0] - 2026-06-07

- Added state-only `Notification` + `NotificationKind` types (status/backend/repo/link only), mirroring the bridge notification seam.

## [0.4.0] - 2026-06-07

- Added an `artifact` variant to `BridgeEventPayload`, mirroring the bridge's new artifact stream event.

## [0.3.0] - 2026-06-07

- Added pairing view types (`BridgeIdentityView`, `PairedDeviceView`, `PairingGrant`) mirroring the bridge serde shapes; only token-free views cross the wire.

## [0.2.0] - 2026-06-07

- Added provisional HoneyHub bridge wire protocol, command, event, and start request types.
- Added `RunHandle` with optional adapter process metadata.
- Added one-shot capability defaults for non-interactive backend adapters.

## [0.1.0] - 2026-06-07

- Added initial session-contract, capability, artifact, usage, and policy hint types.
