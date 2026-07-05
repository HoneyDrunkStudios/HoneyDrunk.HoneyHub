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
        let Some(token) = bearer_token(&context) else {
            return Err(ErrorData::invalid_request(
                "dispatch_agent requires the bridge per-run capability token in an \
                 Authorization: Bearer header; none was presented",
                None,
            ));
        };

        // Host-owned governance: resolve the caller, the backend, the allowlist, and
        // the per-session cap. A denial is returned to the parent as a tool result
        // (never a silent drop — ADR-0098 D2).
        let admission = match self.governor.authorize(&token, &request.backend) {
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
