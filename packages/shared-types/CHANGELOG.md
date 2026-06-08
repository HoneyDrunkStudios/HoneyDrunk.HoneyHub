# Changelog

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
