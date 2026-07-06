//! Bridge-hosted MCP server for cross-backend subagents (ADR-0098 `dispatch_agent`).
//!
//! The bridge exposes one **localhost** streamable-HTTP MCP tool,
//! `dispatch_agent(backend, task, model?, effort?)`, mounted at `/mcp` on the same
//! axum router that serves the WS wire. A HoneyHub-launched CLI reaches it by URL
//! with a per-run capability token in an `Authorization: Bearer` header; the token
//! (minted at launch and injected into the CLI's MCP config, ADR-0098 B) is how the
//! host attributes each dispatch back to the **parent run** that made it.
//!
//! The tool is a member of the ADR-0096 host-owned named-action family: the agent
//! picks a sanctioned backend **id** and a task, never a command line. The
//! [`honeyhub_bridge::DispatchGovernor`] owns the policy — allowlist, per-session
//! child cap, audit — and a dispatched child spawns through the **existing**
//! [`honeyhub_bridge::BridgeRuntime`] start path as a normal, parented bridge run
//! (ADR-0098 C). The endpoint never holds or forwards vendor auth (ADR-0098 F): the
//! capability token is a local handle only, and each child authenticates as its own
//! local CLI session exactly like any operator-started run.

use std::sync::Arc;

use honeyhub_bridge::clock::now_rfc3339;
use honeyhub_bridge::{
    audit_dispatch, backend_id, summarize_task, DispatchDenial, DispatchGovernor, DispatchSession,
    StartRunRequest,
};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};

use crate::Host;

/// The `dispatch_agent` tool arguments. `backend` is a sanctioned id the host
/// resolves (claude/codex/copilot) — never a command line; `model`/`effort` are
/// optional overrides that fall through to the backend's default when omitted.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct DispatchAgentRequest {
    /// The backend to dispatch the subagent to: `claude`, `codex`, or `copilot`.
    pub backend: String,
    /// The instruction text for the subagent.
    pub task: String,
    /// Optional model override; omit to use the backend's configured default.
    #[serde(default)]
    pub model: Option<String>,
    /// Optional reasoning effort (e.g. `high`); backend-specific, ignored where the
    /// CLI has no effort flag.
    #[serde(default)]
    pub effort: Option<String>,
}

/// The MCP server handler. A fresh instance is minted per MCP session by the
/// transport factory; each shares the same host runtime and dispatch governor
/// (behind `Arc`), so a dispatch flows straight into the live bridge.
#[derive(Clone)]
pub struct DispatchAgentServer {
    host: Arc<Host>,
    governor: Arc<DispatchGovernor>,
    tool_router: ToolRouter<DispatchAgentServer>,
}

#[tool_router]
impl DispatchAgentServer {
    pub fn new(host: Arc<Host>, governor: Arc<DispatchGovernor>) -> Self {
        Self {
            host,
            governor,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        description = "Dispatch a subagent on another local backend to work on a task, as a \
parented child run. The host owns backend selection and governance: you pick a sanctioned \
backend id (claude, codex, or copilot) and a task — never a command line. The child runs under \
the operator's own local CLI session and its progress appears on the runs board. Returns the \
child run id."
    )]
    async fn dispatch_agent(
        &self,
        Parameters(request): Parameters<DispatchAgentRequest>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        // The per-run capability token rides the HTTP Authorization header the bridge
        // injected into this CLI's MCP config; it is how the host attributes the call.
        // The governance core is extracted so it is unit-testable without a live MCP
        // request context (see the tests at the foot of this module).
        self.dispatch_core(bearer_token(&context).as_deref(), request)
            .await
    }
}

impl DispatchAgentServer {
    /// The host-owned governance + spawn core, independent of the MCP transport so it can be
    /// driven directly in tests. `token` is the per-run capability token read from the request's
    /// `Authorization: Bearer` header (`None` when absent). All governance denials come back as
    /// caller-visible tool results (never a silent drop — ADR-0098 D2); only a missing token is a
    /// protocol-level error, since it means the endpoint was reached without the injected config.
    async fn dispatch_core(
        &self,
        token: Option<&str>,
        request: DispatchAgentRequest,
    ) -> Result<CallToolResult, ErrorData> {
        let Some(token) = token else {
            return Err(ErrorData::invalid_request(
                "dispatch_agent requires the bridge per-run capability token in an \
                 Authorization: Bearer header; none was presented",
                None,
            ));
        };

        // Govern the optional model/effort overrides before reserving anything: an unknown
        // effort level or a non-model-id-shaped model is refused rather than passed through to
        // the launched CLI's config overrides (ADR-0098 A — the host governs what a dispatch is).
        if let Err(denial) = self
            .governor
            .validate_overrides(request.model.as_deref(), request.effort.as_deref())
        {
            return Ok(denied(&denial));
        }

        // Host-owned governance: resolve the caller, the backend, the allowlist, the depth cap,
        // and the per-session cap. A denial is returned to the parent as a tool result
        // (never a silent drop — ADR-0098 D2).
        let admission = match self.governor.authorize(token, &request.backend) {
            Ok(admission) => admission,
            Err(denial) => return Ok(denied(&denial)),
        };

        // Audit the dispatch (host log; task summary only, never the full prompt).
        audit_dispatch(&admission.caller, admission.backend, &request.task);

        // Build a parented child run: a new session on the dispatched backend, the
        // parent's workspace inherited, and the parent linkage stamped (ADR-0098 C).
        let now = now_rfc3339();
        let child = StartRunRequest {
            session: DispatchSession {
                pinned: false,
                id: crate::new_id(),
                backend: admission.backend,
                title: summarize_task(&request.task),
                workspace_root: admission.caller.workspace_root.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
                current_run_id: None,
            },
            workspace_root: admission.caller.workspace_root.clone(),
            task: request.task.clone(),
            model: request.model.clone(),
            agent: None,
            effort: request.effort.clone(),
            requested_run_id: None,
            follow_up_to_run_id: None,
            transcript: Vec::new(),
            launch_command: None,
            attachments: Vec::new(),
            parent_run_id: Some(admission.caller.run_id.clone()),
            parent_session_id: Some(admission.caller.session_id.clone()),
        };

        // Spawn the child through the EXISTING start path — same pairing, workspace and
        // backend allowlists, capability flags, and usage persistence as any run.
        let started = {
            let mut runtime = self.host.runtime.lock().await;
            runtime.start(child, now)
        };

        match started {
            Ok(handle) => {
                // Register so the host poll loop drains + broadcasts the child's events
                // (it shows up on the runs board like any other run).
                self.host
                    .active_runs
                    .lock()
                    .await
                    .insert(handle.run_id.clone());
                Ok(CallToolResult::success(vec![ContentBlock::text(format!(
                    "Dispatched a {} subagent (run {}). Its progress appears on the runs board.",
                    backend_id(admission.backend),
                    handle.run_id
                ))]))
            }
            Err(error) => {
                // The child never launched: give back the reserved cap slot so a failed
                // start does not permanently burn it.
                self.governor.release(&admission.caller.session_id);
                Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "dispatch could not start the {} child: {} ({})",
                    backend_id(admission.backend),
                    error.message,
                    error.code
                ))]))
            }
        }
    }
}

// `router = self.tool_router` makes the generated handler use the router built once
// in `new` (the default `Self::tool_router()` would rebuild it per call and leave the
// stored field unread).
#[tool_handler(router = self.tool_router)]
impl ServerHandler for DispatchAgentServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_instructions(
                "HoneyHub cross-backend dispatch. Call \
                 dispatch_agent(backend, task, model?, effort?) to spawn a parented subagent on \
                 another local backend (claude, codex, or copilot). The host governs backend \
                 selection, an allowlist, and a per-session child-run cap."
                    .to_string(),
            )
    }
}

/// Read the per-run capability token from the request's `Authorization: Bearer`
/// header. The streamable-HTTP transport injects the incoming `http::request::Parts`
/// into the request context extensions, so the header of the exact HTTP POST that
/// carried this tool call is readable here (per-call attribution, not just at
/// session start). `axum::http` re-exports the same `http` types the transport uses.
fn bearer_token(context: &RequestContext<RoleServer>) -> Option<String> {
    context
        .extensions
        .get::<axum::http::request::Parts>()?
        .headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_owned)
}

/// Render a governance denial as a caller-visible tool error (ADR-0098 D2: the
/// parent sees the refusal as its tool result, tagged with a stable reason code).
fn denied(denial: &DispatchDenial) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(format!(
        "dispatch refused ({}): {}",
        denial.reason.code(),
        denial.message
    ))])
}

/// Build the streamable-HTTP MCP service for the dispatch endpoint, ready to nest
/// into the host's axum router at `/mcp`. The factory mints a fresh handler per MCP
/// session, each sharing the host runtime + governor. `StreamableHttpServerConfig`
/// defaults to loopback-only allowed hosts, which is exactly the local-CLI posture
/// this endpoint wants (ADR-0098 B — localhost only).
pub fn dispatch_service(
    host: Arc<Host>,
    governor: Arc<DispatchGovernor>,
) -> StreamableHttpService<DispatchAgentServer, LocalSessionManager> {
    StreamableHttpService::new(
        move || Ok(DispatchAgentServer::new(host.clone(), governor.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    )
}

#[cfg(test)]
mod tests {
    use super::{DispatchAgentRequest, DispatchAgentServer};
    use crate::Host;
    use honeyhub_bridge::{
        AgentBackend, AgentBackendAdapter, BackendAllowlist, BridgeError, BridgeEvent,
        BridgeRuntime, CapabilityFlags, DispatchCaller, DispatchGovernor, RunHandle,
        StartRunRequest, WorkspaceAllowlist,
    };
    use rmcp::model::CallToolResult;
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::{broadcast, Mutex};

    /// A backend adapter that records the runs it is asked to start and hands back a stable
    /// run id, so the dispatch handler can be exercised end-to-end WITHOUT a real CLI process
    /// (`claude`/`codex` need not be installed).
    struct RecordingAdapter {
        started: Arc<StdMutex<Vec<StartRunRequest>>>,
    }

    impl AgentBackendAdapter for RecordingAdapter {
        fn backend(&self) -> AgentBackend {
            AgentBackend::ClaudeLocal
        }
        fn capabilities(&self) -> CapabilityFlags {
            CapabilityFlags::claude_local()
        }
        fn start(&self, request: StartRunRequest) -> Result<RunHandle, BridgeError> {
            self.started.lock().unwrap().push(request);
            Ok(RunHandle {
                run_id: "child-run".to_string(),
                process_id: Some(4321),
            })
        }
        fn stream(&self, _run_id: &str) -> Result<Vec<BridgeEvent>, BridgeError> {
            Ok(Vec::new())
        }
        fn reply(&self, _run_id: &str, _text: &str) -> Result<(), BridgeError> {
            Ok(())
        }
        fn stop(&self, _run_id: &str) -> Result<(), BridgeError> {
            Ok(())
        }
        fn resume(&self, _session_id_or_transcript: &str) -> Result<RunHandle, BridgeError> {
            Ok(RunHandle {
                run_id: "resumed".to_string(),
                process_id: None,
            })
        }
    }

    /// A governor whose only allowed dispatch backend is Claude, with the given child cap and
    /// max depth (defaults when omitted via the helpers below).
    fn governor_with(cap: usize, max_depth: usize) -> Arc<DispatchGovernor> {
        Arc::new(
            DispatchGovernor::new(
                "http://127.0.0.1:8765/mcp",
                vec![AgentBackend::ClaudeLocal],
                cap,
            )
            .with_max_depth(max_depth),
        )
    }

    fn governor() -> Arc<DispatchGovernor> {
        governor_with(4, 3)
    }

    /// A capability token for a depth-`depth` parent run in session `parent-session`. The
    /// workspace root is empty so the child launches in the home dir and skips the allowlist.
    fn token_at_depth(gov: &DispatchGovernor, depth: usize) -> String {
        gov.issue_token(DispatchCaller {
            session_id: "parent-session".to_string(),
            run_id: "parent-run".to_string(),
            backend: AgentBackend::ClaudeLocal,
            workspace_root: String::new(),
            depth,
        })
    }

    /// Build a server over a runtime backed by the recording adapter, returning the server, the
    /// captured start requests, and the host (for asserting run registration).
    fn harness(
        governor: Arc<DispatchGovernor>,
    ) -> (
        DispatchAgentServer,
        Arc<StdMutex<Vec<StartRunRequest>>>,
        Arc<Host>,
    ) {
        let started = Arc::new(StdMutex::new(Vec::new()));
        let adapter = RecordingAdapter {
            started: started.clone(),
        };
        let runtime = BridgeRuntime::new(
            adapter,
            WorkspaceAllowlist::new(Vec::new()),
            BackendAllowlist::new(vec![AgentBackend::ClaudeLocal, AgentBackend::CodexLocal]),
        );
        let (events_tx, _rx) = broadcast::channel(16);
        let host = Arc::new(Host {
            runtime: Mutex::new(runtime),
            active_runs: Mutex::new(HashSet::new()),
            active_checks: Mutex::new(HashSet::new()),
            active_probes: Mutex::new(HashSet::new()),
            active_lsp: Mutex::new(std::collections::HashMap::new()),
            events: events_tx,
            watcher: Mutex::new(None),
            dispatch: Some(governor.clone()),
        });
        let server = DispatchAgentServer::new(host.clone(), governor);
        (server, started, host)
    }

    fn request(backend: &str) -> DispatchAgentRequest {
        DispatchAgentRequest {
            backend: backend.to_string(),
            task: "do the thing".to_string(),
            model: None,
            effort: None,
        }
    }

    fn as_json(result: &CallToolResult) -> String {
        serde_json::to_string(result).expect("a tool result serializes")
    }

    #[tokio::test]
    async fn missing_token_is_a_protocol_error() {
        let (server, started, _host) = harness(governor());
        let result = server.dispatch_core(None, request("claude")).await;
        assert!(result.is_err(), "a call with no bearer token is rejected");
        assert!(started.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unknown_token_is_denied_as_a_tool_result() {
        let (server, started, _host) = harness(governor());
        let result = server
            .dispatch_core(Some("not-a-real-token"), request("claude"))
            .await
            .expect("a governance denial is a tool result, not a protocol error");
        assert!(as_json(&result).contains("unknown_token"));
        assert!(started.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn disallowed_backend_is_denied() {
        let gov = governor(); // only claude is on the dispatch allowlist
        let token = token_at_depth(&gov, 0);
        let (server, started, _host) = harness(gov);
        let result = server
            .dispatch_core(Some(&token), request("codex"))
            .await
            .expect("a denial is a tool result");
        assert!(as_json(&result).contains("backend_not_allowed"));
        assert!(started.lock().unwrap().is_empty(), "no child was started");
    }

    #[tokio::test]
    async fn invalid_override_is_denied_before_any_child_starts() {
        let gov = governor();
        let token = token_at_depth(&gov, 0);
        let (server, started, _host) = harness(gov);
        let mut req = request("claude");
        req.effort = Some("turbo".to_string());
        let result = server
            .dispatch_core(Some(&token), req)
            .await
            .expect("a denial is a tool result");
        assert!(as_json(&result).contains("invalid_override"));
        assert!(started.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn depth_cap_is_enforced() {
        let gov = governor_with(4, 1); // max depth 1
        let token = token_at_depth(&gov, 1); // parent already at the max depth
        let (server, started, _host) = harness(gov);
        let result = server
            .dispatch_core(Some(&token), request("claude"))
            .await
            .expect("a denial is a tool result");
        assert!(as_json(&result).contains("depth_cap_reached"));
        assert!(started.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn child_cap_is_enforced_across_calls() {
        let gov = governor_with(1, 3); // one child per session
        let token = token_at_depth(&gov, 0);
        let (server, started, _host) = harness(gov);

        let first = server
            .dispatch_core(Some(&token), request("claude"))
            .await
            .expect("the first dispatch succeeds");
        assert!(!as_json(&first).contains("refused"));

        let second = server
            .dispatch_core(Some(&token), request("claude"))
            .await
            .expect("a denial is a tool result");
        assert!(as_json(&second).contains("child_cap_reached"));
        assert_eq!(
            started.lock().unwrap().len(),
            1,
            "only the first child actually started"
        );
    }

    #[tokio::test]
    async fn happy_path_starts_a_parented_child_and_registers_it() {
        let gov = governor();
        let token = token_at_depth(&gov, 0);
        let (server, started, host) = harness(gov);

        let result = server
            .dispatch_core(Some(&token), request("claude"))
            .await
            .expect("the dispatch succeeds");
        let json = as_json(&result);
        assert!(json.contains("Dispatched"), "success text is returned");
        assert!(!json.contains("refused"));

        // Copy out what we need and drop the std guard before the async lock below, so no
        // non-async guard is held across an await point.
        let (parent_run, parent_session, backend) = {
            let starts = started.lock().unwrap();
            assert_eq!(starts.len(), 1);
            let child = &starts[0];
            (
                child.parent_run_id.clone(),
                child.parent_session_id.clone(),
                child.session.backend,
            )
        };
        assert_eq!(parent_run.as_deref(), Some("parent-run"));
        assert_eq!(parent_session.as_deref(), Some("parent-session"));
        assert_eq!(backend, AgentBackend::ClaudeLocal);

        // The child run id is registered so the host poll loop drains + broadcasts its events.
        assert!(host.active_runs.lock().await.contains("child-run"));
    }
}
