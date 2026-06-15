//! Tool/file activity (parity polish #9): the things an agent *does* during a run — read a
//! file, edit a file, run a command, search — surfaced from the CLI's tool-call events so
//! the chat right-panel can show "what the LLM is doing", not just its prose. Metadata only
//! (a label + a short detail like a path or command); never the tool's full input/output.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKind {
    /// Reading a file / listing a dir.
    Read,
    /// Editing or writing a file.
    Edit,
    /// Running a shell command.
    Command,
    /// Searching (grep/glob).
    Search,
    /// Fetching a URL / web search.
    Fetch,
    /// A task/sub-agent or other tool not in the set above.
    Tool,
}

/// One thing the agent did, derived from a CLI tool-call event. `label` is the tool name as
/// surfaced (e.g. `Edit`); `detail` is a short, non-sensitive summary (a repo-relative path
/// or a trimmed command), omitted when nothing safe/short is available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchActivity {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub kind: ActivityKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub created_at: String,
}
