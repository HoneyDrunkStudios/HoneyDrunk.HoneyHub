//! Concrete `AgentBackendAdapter` implementations.
//!
//! Packet 04 defined the backend-agnostic core and the `AgentBackendAdapter`
//! trait; this module holds the real adapters that drive a vendor CLI under the
//! user's own local session (ADR-0090 D2/D10). At v1 only `claude.local` ships.

pub mod claude_local;

pub use claude_local::{default_event_clock, ClaudeLocalAdapter, EventClock};
