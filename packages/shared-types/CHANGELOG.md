# Changelog

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
