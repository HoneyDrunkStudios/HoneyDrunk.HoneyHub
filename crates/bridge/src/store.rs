//! Local-first DispatchSession store (ADR-0092 D1, ADR-0090 D11).
//!
//! Persists the session model **on the device only**: structured records
//! (`DispatchSession`/`DispatchRun`/`DispatchControlEvent`/`DispatchArtifact`/
//! `UsageSignal`/`PolicyHint`) in an embedded JSON document, and transcript
//! bodies (`DispatchMessage`) in **separate** per-run JSONL files the user can pin
//! or prune. Nothing syncs off-device; the model carries no central-store
//! assumption (sync is a later per-session/workspace opt-in).
//!
//! The storage **engine is `[Provisional]`** (ADR-0092 ledger) — a SQLite-class
//! embedded store is the eventual shape; this file-backed document is the v1
//! stand-in behind a stable API. The `[Firm]` parts are local-first storage,
//! transcript/durable separation, and the retention posture.
//!
//! Retention: active transcripts are kept until a run is terminal; a completed
//! session's transcript is kept for a configurable window unless pinned, then
//! pruned ([`LocalStore::prune`]); durable records (status/backend/repo, artifact
//! links, usage totals, outcomes) are kept longer than transcripts and carry no
//! raw prompt/code. The window default is **30 days (`[Provisional]`)** and is
//! applied by the host, which passes the computed cutoff to `prune` (the crate
//! stays clock-free; timestamps come from the caller).

use crate::artifact::DispatchArtifact;
use crate::session::{
    DispatchControlEvent, DispatchMessage, DispatchRun, DispatchSession, PolicyHint, UsageSignal,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub code: String,
    pub message: String,
}

impl StoreError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn io(context: &str, error: std::io::Error) -> Self {
        Self::new("store_io", format!("{context}: {error}"))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRun {
    run: DispatchRun,
    #[serde(default)]
    control_events: Vec<DispatchControlEvent>,
    #[serde(default)]
    artifacts: Vec<DispatchArtifact>,
    #[serde(default)]
    usage: Vec<UsageSignal>,
    #[serde(default)]
    policy_hints: Vec<PolicyHint>,
    /// Set when the run's transcript file has been pruned; the durable record
    /// above survives.
    #[serde(default)]
    transcript_pruned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    session: DispatchSession,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    runs: BTreeMap<String, StoredRun>,
}

/// A session is prunable when it is unpinned, has runs, all of them are terminal, and
/// its newest completion is strictly before `cutoff`. RFC3339 UTC strings sort
/// lexicographically in chronological order.
fn is_prunable(stored: &StoredSession, cutoff: &str) -> bool {
    if stored.pinned || stored.runs.is_empty() {
        return false;
    }
    if !stored.runs.values().all(|run| run.run.state.is_terminal()) {
        return false;
    }
    stored
        .runs
        .values()
        .filter_map(|run| run.run.completed_at.as_deref())
        .max()
        .is_some_and(|newest| newest < cutoff)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreData {
    #[serde(default)]
    sessions: BTreeMap<String, StoredSession>,
}

/// A local-first store rooted at a directory: `store.json` holds the structured
/// records; `transcripts/<run_id>.jsonl` holds each run's transcript bodies.
#[derive(Debug)]
pub struct LocalStore {
    root: PathBuf,
    data: StoreData,
}

impl LocalStore {
    /// Open (or initialize) a store rooted at `root`, loading existing structured
    /// records if present.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|error| StoreError::io("create store root", error))?;
        let document = root.join("store.json");
        let data = if document.exists() {
            let raw = fs::read_to_string(&document)
                .map_err(|error| StoreError::io("read store document", error))?;
            serde_json::from_str(&raw)
                .map_err(|error| StoreError::new("store_decode", error.to_string()))?
        } else {
            StoreData::default()
        };
        Ok(Self { root, data })
    }

    fn save(&self) -> Result<(), StoreError> {
        let raw = serde_json::to_string_pretty(&self.data)
            .map_err(|error| StoreError::new("store_encode", error.to_string()))?;
        // Atomic write: a crash mid-write must not truncate the durable document.
        let temp = self.root.join("store.json.tmp");
        fs::write(&temp, raw).map_err(|error| StoreError::io("write store document", error))?;
        fs::rename(&temp, self.root.join("store.json"))
            .map_err(|error| StoreError::io("commit store document", error))
    }

    fn transcript_path(&self, run_id: &str) -> PathBuf {
        // Sanitize the run id into a flat filename: a `run_id` carrying path
        // separators or `..` (it can originate from the host/client via
        // `requested_run_id`) must never escape the transcripts directory or let
        // `prune` touch arbitrary files.
        let safe: String = run_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        self.root.join("transcripts").join(format!("{safe}.jsonl"))
    }

    /// A durable copy of a run with the prompt `task` stripped — the task is raw
    /// user prompt text (it lives in the transcript), and the durable record must
    /// carry no raw prompt/code (ADR-0090 D11 / ADR-0092 retention).
    fn durable_run(run: &DispatchRun) -> DispatchRun {
        let mut redacted = run.clone();
        redacted.task = String::new();
        redacted
    }

    fn run_mut(&mut self, session_id: &str, run_id: &str) -> Result<&mut StoredRun, StoreError> {
        self.data
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| StoreError::new("session_not_found", format!("session {session_id}")))?
            .runs
            .get_mut(run_id)
            .ok_or_else(|| StoreError::new("run_not_found", format!("run {run_id}")))
    }

    pub fn upsert_session(&mut self, session: &DispatchSession) -> Result<(), StoreError> {
        match self.data.sessions.get_mut(&session.id) {
            Some(stored) => stored.session = session.clone(),
            None => {
                self.data.sessions.insert(
                    session.id.clone(),
                    StoredSession {
                        session: session.clone(),
                        pinned: false,
                        runs: BTreeMap::new(),
                    },
                );
            }
        }
        self.save()
    }

    pub fn put_run(&mut self, run: &DispatchRun) -> Result<(), StoreError> {
        let stored = self.data.sessions.get_mut(&run.session_id).ok_or_else(|| {
            StoreError::new("session_not_found", format!("session {}", run.session_id))
        })?;
        match stored.runs.get_mut(&run.id) {
            Some(existing) => existing.run = Self::durable_run(run),
            None => {
                stored.runs.insert(
                    run.id.clone(),
                    StoredRun {
                        run: Self::durable_run(run),
                        control_events: Vec::new(),
                        artifacts: Vec::new(),
                        usage: Vec::new(),
                        policy_hints: Vec::new(),
                        transcript_pruned: false,
                    },
                );
            }
        }
        self.save()
    }

    pub fn put_control_event(
        &mut self,
        session_id: &str,
        event: &DispatchControlEvent,
    ) -> Result<(), StoreError> {
        self.run_mut(session_id, &event.run_id)?
            .control_events
            .push(event.clone());
        self.save()
    }

    pub fn put_artifact(
        &mut self,
        session_id: &str,
        artifact: &DispatchArtifact,
    ) -> Result<(), StoreError> {
        self.run_mut(session_id, &artifact.run_id)?
            .artifacts
            .push(artifact.clone());
        self.save()
    }

    pub fn put_usage(&mut self, session_id: &str, usage: &UsageSignal) -> Result<(), StoreError> {
        self.run_mut(session_id, &usage.run_id)?
            .usage
            .push(usage.clone());
        self.save()
    }

    pub fn put_policy_hint(
        &mut self,
        session_id: &str,
        hint: &PolicyHint,
    ) -> Result<(), StoreError> {
        let run_id = hint.run_id.clone().ok_or_else(|| {
            StoreError::new("policy_hint_run_required", "policy hint has no run id")
        })?;
        self.run_mut(session_id, &run_id)?
            .policy_hints
            .push(hint.clone());
        self.save()
    }

    /// Append a transcript body to the run's local JSONL file. Transcripts live
    /// outside the structured document so they can be pinned/pruned separately and
    /// never leave the device.
    pub fn append_transcript(&mut self, message: &DispatchMessage) -> Result<(), StoreError> {
        // Fail fast on an unknown session/run before writing anything: an orphan
        // transcript file would never be scanned by `prune`, so raw transcript text
        // could outlive the structured record. Also clear (and persist) the pruned
        // flag if a previously pruned transcript re-appears.
        let mut flipped = false;
        {
            let run = self.run_mut(&message.session_id, &message.run_id)?;
            if run.transcript_pruned {
                run.transcript_pruned = false;
                flipped = true;
            }
        }
        if flipped {
            self.save()?;
        }

        let path = self.transcript_path(&message.run_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| StoreError::io("create transcripts dir", error))?;
        }
        let line = serde_json::to_string(message)
            .map_err(|error| StoreError::new("store_encode", error.to_string()))?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| StoreError::io("open transcript file", error))?;
        writeln!(file, "{line}").map_err(|error| StoreError::io("append transcript", error))?;
        Ok(())
    }

    pub fn read_transcript(&self, run_id: &str) -> Result<Vec<DispatchMessage>, StoreError> {
        let path = self.transcript_path(run_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let raw =
            fs::read_to_string(&path).map_err(|error| StoreError::io("read transcript", error))?;
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line)
                    .map_err(|error| StoreError::new("store_decode", error.to_string()))
            })
            .collect()
    }

    pub fn sessions(&self) -> Vec<DispatchSession> {
        self.data
            .sessions
            .values()
            .map(|stored| stored.session.clone())
            .collect()
    }

    pub fn runs(&self, session_id: &str) -> Vec<DispatchRun> {
        self.data
            .sessions
            .get(session_id)
            .map(|stored| stored.runs.values().map(|run| run.run.clone()).collect())
            .unwrap_or_default()
    }

    pub fn artifacts(&self, session_id: &str, run_id: &str) -> Vec<DispatchArtifact> {
        self.data
            .sessions
            .get(session_id)
            .and_then(|stored| stored.runs.get(run_id))
            .map(|run| run.artifacts.clone())
            .unwrap_or_default()
    }

    pub fn usage(&self, session_id: &str, run_id: &str) -> Vec<UsageSignal> {
        self.data
            .sessions
            .get(session_id)
            .and_then(|stored| stored.runs.get(run_id))
            .map(|run| run.usage.clone())
            .unwrap_or_default()
    }

    pub fn is_pinned(&self, session_id: &str) -> bool {
        self.data
            .sessions
            .get(session_id)
            .map(|stored| stored.pinned)
            .unwrap_or(false)
    }

    pub fn set_pinned(&mut self, session_id: &str, pinned: bool) -> Result<(), StoreError> {
        self.data
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| StoreError::new("session_not_found", format!("session {session_id}")))?
            .pinned = pinned;
        self.save()
    }

    /// Prune transcript files for **unpinned** sessions whose runs are all terminal
    /// and whose newest completion is strictly before `cutoff` (an RFC3339 string;
    /// the host computes `now - retention_window`). Durable records survive — only
    /// the transcript bodies are removed. Returns the number of sessions pruned.
    pub fn prune(&mut self, cutoff: &str) -> Result<usize, StoreError> {
        let prunable: Vec<String> = self
            .data
            .sessions
            .iter()
            .filter(|(_, stored)| is_prunable(stored, cutoff))
            .map(|(session_id, _)| session_id.clone())
            .collect();

        for session_id in &prunable {
            self.prune_session(session_id)?;
        }

        if !prunable.is_empty() {
            self.save()?;
        }
        Ok(prunable.len())
    }

    /// Remove the transcript files for every run of one session and mark each run's
    /// body as pruned. Durable records survive — only the transcript bodies go.
    fn prune_session(&mut self, session_id: &str) -> Result<(), StoreError> {
        let run_ids: Vec<String> = self
            .data
            .sessions
            .get(session_id)
            .map(|stored| stored.runs.keys().cloned().collect())
            .unwrap_or_default();
        for run_id in run_ids {
            let path = self.transcript_path(&run_id);
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|error| StoreError::io("prune transcript", error))?;
            }
            if let Some(stored) = self.data.sessions.get_mut(session_id) {
                if let Some(run) = stored.runs.get_mut(&run_id) {
                    run.transcript_pruned = true;
                }
            }
        }
        Ok(())
    }

    pub fn transcript_pruned(&self, session_id: &str, run_id: &str) -> bool {
        self.data
            .sessions
            .get(session_id)
            .and_then(|stored| stored.runs.get(run_id))
            .map(|run| run.transcript_pruned)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::AgentBackend;
    use crate::artifact::ArtifactKind;
    use crate::session::{DispatchMessageRole, DispatchRunState, UsageFidelity};

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("honeyhub-store-{}", uuid::Uuid::new_v4()))
    }

    fn session(id: &str) -> DispatchSession {
        DispatchSession {
            id: id.to_string(),
            backend: AgentBackend::ClaudeLocal,
            title: "Store test".to_string(),
            workspace_root: "/work".to_string(),
            created_at: "2026-06-01T00:00:00.000Z".to_string(),
            updated_at: "2026-06-01T00:00:00.000Z".to_string(),
            current_run_id: None,
        }
    }

    fn terminal_run(session_id: &str, run_id: &str, completed_at: &str) -> DispatchRun {
        DispatchRun {
            id: run_id.to_string(),
            session_id: session_id.to_string(),
            state: DispatchRunState::Completed,
            task: "do it".to_string(),
            started_at: Some("2026-06-01T00:00:00.000Z".to_string()),
            completed_at: Some(completed_at.to_string()),
            failure_reason: None,
        }
    }

    fn message(session_id: &str, run_id: &str, body: &str) -> DispatchMessage {
        DispatchMessage {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            role: DispatchMessageRole::Agent,
            body: body.to_string(),
            created_at: "2026-06-01T00:00:00.000Z".to_string(),
            is_partial: Some(false),
        }
    }

    #[test]
    fn persists_and_reloads_structured_records_and_transcripts() {
        let root = temp_root();
        {
            let mut store = LocalStore::open(&root).expect("opens");
            store.upsert_session(&session("s1")).expect("session");
            store
                .put_run(&terminal_run("s1", "r1", "2026-06-01T01:00:00.000Z"))
                .expect("run");
            store
                .put_artifact(
                    "s1",
                    &DispatchArtifact {
                        id: "a1".to_string(),
                        session_id: "s1".to_string(),
                        run_id: "r1".to_string(),
                        kind: ArtifactKind::PullRequest,
                        label: "PR".to_string(),
                        href: Some("https://example.test/pr/1".to_string()),
                        repo_relative_path: None,
                        created_at: "2026-06-01T01:00:00.000Z".to_string(),
                    },
                )
                .expect("artifact");
            store
                .put_usage(
                    "s1",
                    &UsageSignal {
                        id: "u1".to_string(),
                        session_id: "s1".to_string(),
                        run_id: "r1".to_string(),
                        backend: AgentBackend::ClaudeLocal,
                        fidelity: UsageFidelity::Exact,
                        model_label: None,
                        input_tokens: Some(10),
                        output_tokens: Some(5),
                        total_tokens: Some(15),
                        total_usd: Some(0.01),
                        premium_requests: None,
                        duration_ms: None,
                        confidence: None,
                        recorded_at: "2026-06-01T01:00:00.000Z".to_string(),
                    },
                )
                .expect("usage");
            store
                .append_transcript(&message("s1", "r1", "hello"))
                .expect("transcript");
        }

        // Reopen: structured records and transcript survive a restart.
        let store = LocalStore::open(&root).expect("reopens");
        assert_eq!(store.sessions().len(), 1);
        assert_eq!(store.runs("s1").len(), 1);
        // The durable run record carries no raw prompt: `task` is redacted (the
        // prompt lives in the transcript).
        assert!(store.runs("s1")[0].task.is_empty());
        assert_eq!(store.artifacts("s1", "r1").len(), 1);
        assert_eq!(store.usage("s1", "r1")[0].fidelity, UsageFidelity::Exact);
        let transcript = store.read_transcript("r1").expect("reads transcript");
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0].body, "hello");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_removes_unpinned_old_transcripts_but_keeps_durable_records() {
        let root = temp_root();
        let mut store = LocalStore::open(&root).expect("opens");
        store.upsert_session(&session("s1")).expect("session");
        store
            .put_run(&terminal_run("s1", "r1", "2026-01-01T00:00:00.000Z"))
            .expect("run");
        store
            .append_transcript(&message("s1", "r1", "old transcript"))
            .expect("transcript");

        // Cutoff after the completion → prune.
        let pruned = store.prune("2026-06-01T00:00:00.000Z").expect("prunes");
        assert_eq!(pruned, 1);
        assert!(store.read_transcript("r1").expect("reads").is_empty());
        assert!(store.transcript_pruned("s1", "r1"));
        // Durable records survive the prune.
        assert_eq!(store.runs("s1").len(), 1);
        assert_eq!(store.sessions().len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pinned_sessions_survive_prune() {
        let root = temp_root();
        let mut store = LocalStore::open(&root).expect("opens");
        store.upsert_session(&session("s1")).expect("session");
        store
            .put_run(&terminal_run("s1", "r1", "2026-01-01T00:00:00.000Z"))
            .expect("run");
        store
            .append_transcript(&message("s1", "r1", "kept transcript"))
            .expect("transcript");
        store.set_pinned("s1", true).expect("pin");

        let pruned = store.prune("2026-06-01T00:00:00.000Z").expect("prunes");
        assert_eq!(pruned, 0);
        assert_eq!(store.read_transcript("r1").expect("reads").len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn active_run_transcripts_are_not_pruned() {
        let root = temp_root();
        let mut store = LocalStore::open(&root).expect("opens");
        store.upsert_session(&session("s1")).expect("session");
        let mut active = terminal_run("s1", "r1", "2026-01-01T00:00:00.000Z");
        active.state = DispatchRunState::Running;
        active.completed_at = None;
        store.put_run(&active).expect("run");
        store
            .append_transcript(&message("s1", "r1", "live transcript"))
            .expect("transcript");

        let pruned = store.prune("2026-06-01T00:00:00.000Z").expect("prunes");
        assert_eq!(pruned, 0);
        assert_eq!(store.read_transcript("r1").expect("reads").len(), 1);

        let _ = fs::remove_dir_all(&root);
    }
}
