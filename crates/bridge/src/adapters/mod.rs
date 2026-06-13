//! Concrete `AgentBackendAdapter` implementations.
//!
//! Packet 04 defined the backend-agnostic core and the `AgentBackendAdapter`
//! trait; this module holds the real adapters that drive a vendor CLI under the
//! user's own local session (ADR-0090 D2/D10). Each adapter is a thin strategy
//! over the shared [`child_run`] process driver: it supplies the command, the
//! capability flags, the CLI's JSONL line parsing, and its reply mechanism, while
//! the driver owns the spawn/stream/kill/reap mechanics. At v1 only `claude.local`
//! ships; `codex.local` and `copilot.local` follow on the same driver.

pub mod child_run;
pub mod claude_local;
pub mod codex_local;
pub mod common;
pub mod copilot_local;

pub use child_run::{default_event_clock, ChildRun, EventClock, RunSlot};
pub use claude_local::ClaudeLocalAdapter;
pub use codex_local::CodexLocalAdapter;
pub use copilot_local::CopilotLocalAdapter;
