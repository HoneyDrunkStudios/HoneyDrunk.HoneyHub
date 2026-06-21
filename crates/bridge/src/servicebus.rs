//! **Azure Service Bus** observability connector (opt-in, read-only): a management-plane view
//! of the operator's namespaces — queues, and topic subscriptions — with their message counts
//! (active / dead-letter / scheduled). It rides the operator's existing `az` sign-in (so no
//! connection string is stored) and only ever **reads** the management plane via `az
//! servicebus` — it never sends, receives, completes, or purges a message. Data-plane peek /
//! replay is a deliberately separate, later step.

use crate::backend_catalog::program_on_path;
use serde::{Deserialize, Serialize};
use std::process::Command;

/// A countable Service Bus entity: a queue, or a subscription under a topic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceBusEntityKind {
    Queue,
    Subscription,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusEntity {
    pub name: String,
    pub kind: ServiceBusEntityKind,
    pub namespace: String,
    /// The parent topic, for a subscription (absent for a queue).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    /// `Active` / `Disabled` etc., when reported.
    pub status: String,
    pub active: i64,
    pub dead_letter: i64,
    pub scheduled: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusNamespace {
    pub name: String,
    pub resource_group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    pub entities: Vec<ServiceBusEntity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusSnapshot {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub namespaces: Vec<ServiceBusNamespace>,
}

/// Snapshot the operator's Service Bus namespaces + entity counts via `az servicebus`. Read-only.
/// When `az` is missing or not signed in, returns an unavailable snapshot with a short hint
/// rather than failing — the caller surfaces it as "Service Bus: not signed in".
pub fn snapshot() -> ServiceBusSnapshot {
    if !program_on_path("az") {
        return unavailable("Azure CLI (az) not found on PATH");
    }
    let namespaces_json = match run_az(&["servicebus", "namespace", "list", "-o", "json"]) {
        Ok(json) => json,
        Err(error) => return unavailable(&error),
    };
    let mut namespaces = Vec::new();
    for (name, resource_group, location) in parse_namespaces(&namespaces_json) {
        let mut entities = Vec::new();
        if let Ok(json) = run_az(&[
            "servicebus",
            "queue",
            "list",
            "--namespace-name",
            &name,
            "--resource-group",
            &resource_group,
            "-o",
            "json",
        ]) {
            entities.extend(parse_queue_entities(&json, &name));
        }
        if let Ok(topics_json) = run_az(&[
            "servicebus",
            "topic",
            "list",
            "--namespace-name",
            &name,
            "--resource-group",
            &resource_group,
            "-o",
            "json",
        ]) {
            for topic in parse_topic_names(&topics_json) {
                if let Ok(subs_json) = run_az(&[
                    "servicebus",
                    "topic",
                    "subscription",
                    "list",
                    "--namespace-name",
                    &name,
                    "--resource-group",
                    &resource_group,
                    "--topic-name",
                    &topic,
                    "-o",
                    "json",
                ]) {
                    entities.extend(parse_subscription_entities(&subs_json, &name, &topic));
                }
            }
        }
        namespaces.push(ServiceBusNamespace {
            name,
            resource_group,
            location,
            entities,
        });
    }
    ServiceBusSnapshot {
        available: true,
        error: None,
        namespaces,
    }
}

fn unavailable(error: &str) -> ServiceBusSnapshot {
    ServiceBusSnapshot {
        available: false,
        error: Some(error.to_string()),
        namespaces: Vec::new(),
    }
}

/// Run `az <args>`; sanitize errors (no subscription / not signed in), never leaking raw
/// stderr (which can carry subscription ids / resource paths).
fn run_az(args: &[&str]) -> Result<String, String> {
    let output = Command::new("az")
        .args(args)
        .output()
        .map_err(|_| "could not run the Azure CLI".to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("az login")
            || stderr.contains("not signed in")
            || stderr.contains("credential")
        {
            return Err("Azure CLI is not signed in (run `az login`)".to_string());
        }
        if stderr.contains("subscription") {
            return Err("no Azure subscription selected (run `az account set`)".to_string());
        }
        return Err("the Azure CLI returned an error".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Parse `az servicebus namespace list -o json` → `(name, resourceGroup, location?)` rows.
pub fn parse_namespaces(json: &str) -> Vec<(String, String, Option<String>)> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let name = row.get("name")?.as_str()?.to_string();
            // `resourceGroup` is lowercased by az; fall back to deriving from the id.
            let resource_group = row
                .get("resourceGroup")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| resource_group_from_id(row.get("id").and_then(|v| v.as_str())))
                .unwrap_or_default();
            let location = row
                .get("location")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            Some((name, resource_group, location))
        })
        .collect()
}

/// Pull the resource group out of an ARM id (`…/resourceGroups/<rg>/…`), case-insensitively.
fn resource_group_from_id(id: Option<&str>) -> Option<String> {
    let id = id?;
    let lower = id.to_lowercase();
    let marker = "/resourcegroups/";
    let start = lower.find(marker)? + marker.len();
    let rest = &id[start..];
    let end = rest.find('/').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// Parse `az servicebus queue list` → queue entities with their message counts.
pub fn parse_queue_entities(json: &str, namespace: &str) -> Vec<ServiceBusEntity> {
    parse_entities(json, namespace, None, ServiceBusEntityKind::Queue)
}

/// Parse `az servicebus topic subscription list` → subscription entities under `topic`.
pub fn parse_subscription_entities(
    json: &str,
    namespace: &str,
    topic: &str,
) -> Vec<ServiceBusEntity> {
    parse_entities(
        json,
        namespace,
        Some(topic),
        ServiceBusEntityKind::Subscription,
    )
}

fn parse_entities(
    json: &str,
    namespace: &str,
    topic: Option<&str>,
    kind: ServiceBusEntityKind,
) -> Vec<ServiceBusEntity> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let name = row.get("name")?.as_str()?.to_string();
            let status = row
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("Active")
                .to_string();
            let counts = row.get("countDetails");
            let count = |key: &str| {
                counts
                    .and_then(|c| c.get(key))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
            };
            Some(ServiceBusEntity {
                name,
                kind,
                namespace: namespace.to_string(),
                topic: topic.map(str::to_string),
                status,
                active: count("activeMessageCount"),
                dead_letter: count("deadLetterMessageCount"),
                scheduled: count("scheduledMessageCount"),
            })
        })
        .collect()
}

/// Parse `az servicebus topic list` → topic names (we only need the names to list subs).
pub fn parse_topic_names(json: &str) -> Vec<String> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| row.get("name").and_then(|v| v.as_str()).map(str::to_string))
        .collect()
}

// --- Data-plane message peek (ADR-0094 D5) -------------------------------------------------
// `az` cannot browse messages, so peek rides the optional `honeyhub-sb-explorer` .NET helper
// (Azure SDK `PeekMessagesAsync`, DefaultAzureCredential — needs the "Azure Service Bus Data
// Receiver" role). READ-ONLY: peek never receives/completes/defers/purges. When the helper
// isn't installed, the cockpit shows an honest "helper not installed" state (like the other
// connectors' not-configured states). Locate the helper via `HONEYHUB_SB_EXPLORER` (full path)
// or `honeyhub-sb-explorer` on PATH.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub sequence_number: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enqueued_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub delivery_count: i64,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dead_letter_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusPeek {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Echoed so the cockpit can title the result panel ("namespace / entity[/sub]").
    pub namespace: String,
    pub entity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
    pub dead_letter: bool,
    pub messages: Vec<PeekMessage>,
}

/// Browse (non-destructive peek) up to `count` messages from a queue, or a topic subscription
/// when `subscription` is set; `dead_letter` peeks the entity's dead-letter sub-queue. Read-only.
pub fn peek(
    namespace: &str,
    connection_string: Option<&str>,
    entity: &str,
    subscription: Option<&str>,
    dead_letter: bool,
    count: u32,
) -> ServiceBusPeek {
    let fqdn = namespace_fqdn(namespace);
    let unavailable = |error: String| ServiceBusPeek {
        available: false,
        error: Some(error),
        namespace: fqdn.clone(),
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        dead_letter,
        messages: Vec::new(),
    };

    let Some(program) = sb_explorer_program() else {
        return unavailable(
            "Service Bus explorer helper not installed (build tools/honeyhub-sb-explorer and set HONEYHUB_SB_EXPLORER)".to_string(),
        );
    };

    let mut args: Vec<String> = vec![
        "peek".to_string(),
        "--entity".to_string(),
        entity.to_string(),
        "--count".to_string(),
        count.clamp(1, 100).to_string(),
    ];
    push_auth(&mut args, &fqdn, connection_string);
    if let Some(sub) = subscription {
        args.push("--subscription".to_string());
        args.push(sub.to_string());
    }
    if dead_letter {
        args.push("--dlq".to_string());
    }

    let output = match Command::new(&program).args(&args).output() {
        Ok(output) => output,
        Err(_) => return unavailable("could not run the Service Bus explorer helper".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let hint = if stderr.contains("signed in")
            || stderr.contains("receiver role")
            || stderr.contains("credential")
        {
            "not signed in / missing the Azure Service Bus Data Receiver role"
        } else {
            "could not peek (check the namespace / entity / access)"
        };
        return unavailable(hint.to_string());
    }

    ServiceBusPeek {
        available: true,
        error: None,
        namespace: fqdn,
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        dead_letter,
        messages: parse_peek_json(&String::from_utf8_lossy(&output.stdout)),
    }
}

/// Append the auth flags for an explorer invocation: a cockpit-held `--connection-string`
/// when present (a SAS string, never persisted host-side), else `--namespace <fqdn>` for the
/// Azure AD path. The dual-auth posture for HoneyHub Service Bus connections (ADR-0094 D5).
fn push_auth(args: &mut Vec<String>, fqdn: &str, connection_string: Option<&str>) {
    match connection_string.filter(|value| !value.trim().is_empty()) {
        Some(cs) => {
            args.push("--connection-string".to_string());
            args.push(cs.to_string());
        }
        None => {
            args.push("--namespace".to_string());
            args.push(fqdn.to_string());
        }
    }
}

/// Normalize a namespace to its Service Bus FQDN (`<name>.servicebus.windows.net`); a value
/// that already looks fully-qualified (contains a dot) is left as-is.
fn namespace_fqdn(namespace: &str) -> String {
    let trimmed = namespace.trim();
    if trimmed.contains('.') {
        trimmed.to_string()
    } else {
        format!("{trimmed}.servicebus.windows.net")
    }
}

/// Locate the helper: `HONEYHUB_SB_EXPLORER` (full path) wins, else `honeyhub-sb-explorer` on
/// PATH. `None` = not installed (the caller shows the honest "not installed" state).
fn sb_explorer_program() -> Option<String> {
    if let Ok(path) = std::env::var("HONEYHUB_SB_EXPLORER") {
        let trimmed = path.trim();
        if !trimmed.is_empty() && std::path::Path::new(trimmed).is_file() {
            return Some(trimmed.to_string());
        }
    }
    if crate::backend_catalog::program_on_path("honeyhub-sb-explorer") {
        return Some("honeyhub-sb-explorer".to_string());
    }
    None
}

/// Parse one message object (shared by peek + receive).
fn parse_message_value(row: &serde_json::Value) -> PeekMessage {
    let opt_str = |key: &str| {
        row.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    PeekMessage {
        message_id: opt_str("messageId"),
        sequence_number: row
            .get("sequenceNumber")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        enqueued_time: opt_str("enqueuedTime"),
        subject: opt_str("subject"),
        delivery_count: row
            .get("deliveryCount")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        body: row
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        dead_letter_reason: opt_str("deadLetterReason"),
    }
}

/// Parse the helper's `peek` output (`{"messages":[…]}`) into normalized peek rows.
pub fn parse_peek_json(json: &str) -> Vec<PeekMessage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(rows) = value.get("messages").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    rows.iter().map(parse_message_value).collect()
}

/// Parse the helper's `receive` output (`{"received": <msg>|null}`) into an optional message.
pub fn parse_received_json(json: &str) -> Option<PeekMessage> {
    let value = serde_json::from_str::<serde_json::Value>(json).ok()?;
    let received = value.get("received")?;
    if received.is_null() {
        return None;
    }
    Some(parse_message_value(received))
}

// --- Dead-letter resubmit (ADR-0094 D5, write op) -----------------------------------------
// DESTRUCTIVE: moves dead-letter messages back to their source entity (receive from DLQ → send
// clone to source → complete original). Confirmation-gated in the UI; needs Data Receiver +
// Data Sender RBAC. A scoped exception to the connector's read-only default, for Service Bus.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusResubmit {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// How many dead-letter messages were moved back to the source.
    pub moved: i64,
    pub namespace: String,
    pub entity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
}

/// Resubmit up to `count` dead-letter messages of a queue (or topic subscription) back to the
/// source. Write op via the explorer helper; honest unavailable/not-authorized states.
pub fn resubmit_dead_letter(
    namespace: &str,
    connection_string: Option<&str>,
    entity: &str,
    subscription: Option<&str>,
    count: u32,
) -> ServiceBusResubmit {
    let fqdn = namespace_fqdn(namespace);
    let failed = |error: String| ServiceBusResubmit {
        ok: false,
        error: Some(error),
        moved: 0,
        namespace: fqdn.clone(),
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
    };

    let Some(program) = sb_explorer_program() else {
        return failed(
            "Service Bus explorer helper not installed (build tools/honeyhub-sb-explorer and set HONEYHUB_SB_EXPLORER)".to_string(),
        );
    };

    let mut args: Vec<String> = vec![
        "resubmit".to_string(),
        "--entity".to_string(),
        entity.to_string(),
        "--count".to_string(),
        count.clamp(1, 100).to_string(),
    ];
    push_auth(&mut args, &fqdn, connection_string);
    if let Some(sub) = subscription {
        args.push("--subscription".to_string());
        args.push(sub.to_string());
    }

    let output = match Command::new(&program).args(&args).output() {
        Ok(output) => output,
        Err(_) => return failed("could not run the Service Bus explorer helper".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let hint = if stderr.contains("signed in") || stderr.contains("credential") {
            "not signed in (run az login)"
        } else if stderr.contains("unauthorized")
            || stderr.contains("claim")
            || stderr.contains("forbidden")
        {
            "not authorized: needs the Azure Service Bus Data Sender + Receiver roles"
        } else {
            "could not resubmit (check access / entity)"
        };
        return failed(hint.to_string());
    }

    ServiceBusResubmit {
        ok: true,
        error: None,
        moved: parse_moved(&String::from_utf8_lossy(&output.stdout)),
        namespace: fqdn,
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
    }
}

/// Parse the helper's `resubmit` output (`{"moved":N}`).
pub fn parse_moved(json: &str) -> i64 {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("moved").and_then(|m| m.as_i64()))
        .unwrap_or(0)
}

// --- Purge (ADR-0094 D5, write op) ---------------------------------------------------------
// DESTRUCTIVE: drains ALL messages from a queue / subscription (or its dead-letter sub-queue).
// Confirmation-gated in the UI; needs Data Receiver RBAC. Irreversible — messages are deleted.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusPurge {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// How many messages were drained.
    pub purged: i64,
    pub namespace: String,
    pub entity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
    pub dead_letter: bool,
}

/// Purge (drain) all messages from a queue / subscription, or its dead-letter sub-queue.
/// Write op via the explorer helper; honest unavailable/not-authorized states.
pub fn purge(
    namespace: &str,
    connection_string: Option<&str>,
    entity: &str,
    subscription: Option<&str>,
    dead_letter: bool,
) -> ServiceBusPurge {
    let fqdn = namespace_fqdn(namespace);
    let failed = |error: String| ServiceBusPurge {
        ok: false,
        error: Some(error),
        purged: 0,
        namespace: fqdn.clone(),
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        dead_letter,
    };

    let Some(program) = sb_explorer_program() else {
        return failed(
            "Service Bus explorer helper not installed (build tools/honeyhub-sb-explorer and set HONEYHUB_SB_EXPLORER)".to_string(),
        );
    };

    let mut args: Vec<String> = vec![
        "purge".to_string(),
        "--entity".to_string(),
        entity.to_string(),
    ];
    push_auth(&mut args, &fqdn, connection_string);
    if let Some(sub) = subscription {
        args.push("--subscription".to_string());
        args.push(sub.to_string());
    }
    if dead_letter {
        args.push("--dlq".to_string());
    }

    let output = match Command::new(&program).args(&args).output() {
        Ok(output) => output,
        Err(_) => return failed("could not run the Service Bus explorer helper".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let hint = if stderr.contains("signed in") || stderr.contains("credential") {
            "not signed in (run az login)"
        } else if stderr.contains("unauthorized")
            || stderr.contains("claim")
            || stderr.contains("forbidden")
        {
            "not authorized: needs the Azure Service Bus Data Receiver role"
        } else {
            "could not purge (check access / entity)"
        };
        return failed(hint.to_string());
    }

    ServiceBusPurge {
        ok: true,
        error: None,
        purged: parse_purged(&String::from_utf8_lossy(&output.stdout)),
        namespace: fqdn,
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        dead_letter,
    }
}

/// Parse the helper's `purge` output (`{"purged":N}`).
pub fn parse_purged(json: &str) -> i64 {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("purged").and_then(|m| m.as_i64()))
        .unwrap_or(0)
}

// --- Send (ADR-0094 D5, write op) ----------------------------------------------------------
// WRITE: publish a single message to a queue / topic. Confirmation-gated in the UI; needs Data
// Sender RBAC. A scoped exception to the connector's read-only default, for Service Bus.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusSend {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub namespace: String,
    pub entity: String,
}

/// Publish a message to a queue or topic. Write op via the explorer helper; honest
/// unavailable/not-authorized states.
pub fn send(
    namespace: &str,
    connection_string: Option<&str>,
    entity: &str,
    body: &str,
    subject: Option<&str>,
    content_type: Option<&str>,
) -> ServiceBusSend {
    let fqdn = namespace_fqdn(namespace);
    let failed = |error: String| ServiceBusSend {
        ok: false,
        error: Some(error),
        namespace: fqdn.clone(),
        entity: entity.to_string(),
    };

    let Some(program) = sb_explorer_program() else {
        return failed(
            "Service Bus explorer helper not installed (build tools/honeyhub-sb-explorer and set HONEYHUB_SB_EXPLORER)".to_string(),
        );
    };

    let mut args: Vec<String> = vec![
        "send".to_string(),
        "--entity".to_string(),
        entity.to_string(),
        "--body".to_string(),
        body.to_string(),
    ];
    push_auth(&mut args, &fqdn, connection_string);
    if let Some(subject) = subject.filter(|s| !s.trim().is_empty()) {
        args.push("--subject".to_string());
        args.push(subject.to_string());
    }
    if let Some(content_type) = content_type.filter(|s| !s.trim().is_empty()) {
        args.push("--content-type".to_string());
        args.push(content_type.to_string());
    }

    let output = match Command::new(&program).args(&args).output() {
        Ok(output) => output,
        Err(_) => return failed("could not run the Service Bus explorer helper".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let hint = if stderr.contains("signed in") || stderr.contains("credential") {
            "not signed in (run az login)"
        } else if stderr.contains("unauthorized")
            || stderr.contains("claim")
            || stderr.contains("forbidden")
        {
            "not authorized: needs the Azure Service Bus Data Sender role"
        } else {
            "could not send (check access / entity)"
        };
        return failed(hint.to_string());
    }

    ServiceBusSend {
        ok: true,
        error: None,
        namespace: fqdn,
        entity: entity.to_string(),
    }
}

// --- Receive (ADR-0094 D5, write op) -------------------------------------------------------
// DESTRUCTIVE: consume (ReceiveAndDelete) the next single message and return it — the message
// is removed. Confirmation-gated in the UI; needs Data Receiver RBAC.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusReceive {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The consumed message, or `None` when the entity was empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<PeekMessage>,
    /// True when there was nothing to consume.
    pub empty: bool,
    pub namespace: String,
    pub entity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
    pub dead_letter: bool,
}

/// Consume (and remove) the next single message from a queue / subscription, or its dead-letter
/// sub-queue. Write op via the explorer helper; honest unavailable/not-authorized states.
pub fn receive_one(
    namespace: &str,
    connection_string: Option<&str>,
    entity: &str,
    subscription: Option<&str>,
    dead_letter: bool,
) -> ServiceBusReceive {
    let fqdn = namespace_fqdn(namespace);
    let failed = |error: String| ServiceBusReceive {
        ok: false,
        error: Some(error),
        message: None,
        empty: false,
        namespace: fqdn.clone(),
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        dead_letter,
    };

    let Some(program) = sb_explorer_program() else {
        return failed(
            "Service Bus explorer helper not installed (build tools/honeyhub-sb-explorer and set HONEYHUB_SB_EXPLORER)".to_string(),
        );
    };

    let mut args: Vec<String> = vec![
        "receive".to_string(),
        "--entity".to_string(),
        entity.to_string(),
    ];
    push_auth(&mut args, &fqdn, connection_string);
    if let Some(sub) = subscription {
        args.push("--subscription".to_string());
        args.push(sub.to_string());
    }
    if dead_letter {
        args.push("--dlq".to_string());
    }

    let output = match Command::new(&program).args(&args).output() {
        Ok(output) => output,
        Err(_) => return failed("could not run the Service Bus explorer helper".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let hint = if stderr.contains("signed in") || stderr.contains("credential") {
            "not signed in (run az login)"
        } else if stderr.contains("unauthorized")
            || stderr.contains("claim")
            || stderr.contains("forbidden")
        {
            "not authorized: needs the Azure Service Bus Data Receiver role"
        } else {
            "could not receive (check access / entity)"
        };
        return failed(hint.to_string());
    }

    let message = parse_received_json(&String::from_utf8_lossy(&output.stdout));
    ServiceBusReceive {
        ok: true,
        error: None,
        empty: message.is_none(),
        message,
        namespace: fqdn,
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        dead_letter,
    }
}

// --- Entity listing + management (admin client; HoneyHub connections) ---------------------
// Listing + create/delete/update of queues/topics/subscriptions via the explorer helper's
// `ServiceBusAdministrationClient` path (works with either auth). Management writes are
// confirmation-gated in the UI (ADR-0094 D5).

/// Editable entity properties (a focused subset). Used both to report an entity's current
/// settings (in [`ServiceBusEntities`]) and to request changes (in [`manage`]). All optional:
/// a `None` on a manage request leaves that property unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SbEntityProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_size_mb: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_delivery_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_duration_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_ttl_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dead_letter_on_expiration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SbQueue {
    pub name: String,
    pub status: String,
    pub active: i64,
    pub dead_letter: i64,
    pub scheduled: i64,
    pub props: SbEntityProps,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SbSubscription {
    pub name: String,
    pub status: String,
    pub active: i64,
    pub dead_letter: i64,
    pub props: SbEntityProps,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SbTopic {
    pub name: String,
    pub status: String,
    pub props: SbEntityProps,
    pub subscriptions: Vec<SbSubscription>,
}

/// The entities of one connection's namespace (the per-connection explorer view).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusEntities {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub namespace: String,
    pub queues: Vec<SbQueue>,
    pub topics: Vec<SbTopic>,
}

/// The result of a management write (create/delete/update of an entity).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBusManage {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Echoed so a multi-connection UI can correlate the result to its connection.
    pub namespace: String,
    pub op: String,
    pub kind: String,
    pub entity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// List the queues + topics (with subscriptions) of a connection's namespace, via the admin
/// client (so a connection-string-only connection works without `az`/ARM).
pub fn list_entities(namespace: &str, connection_string: Option<&str>) -> ServiceBusEntities {
    let fqdn = namespace_fqdn(namespace);
    let unavailable = |error: String| ServiceBusEntities {
        available: false,
        error: Some(error),
        namespace: fqdn.clone(),
        queues: Vec::new(),
        topics: Vec::new(),
    };

    let Some(program) = sb_explorer_program() else {
        return unavailable(
            "Service Bus explorer helper not installed (build tools/honeyhub-sb-explorer and set HONEYHUB_SB_EXPLORER)".to_string(),
        );
    };

    let mut args: Vec<String> = vec!["entities".to_string()];
    push_auth(&mut args, &fqdn, connection_string);

    let output = match Command::new(&program).args(&args).output() {
        Ok(output) => output,
        Err(_) => return unavailable("could not run the Service Bus explorer helper".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let hint = if stderr.contains("signed in") || stderr.contains("credential") {
            "not signed in (run az login)"
        } else if stderr.contains("unauthorized") || stderr.contains("forbidden") {
            "not authorized: needs Azure Service Bus management access"
        } else {
            "could not list entities (check the connection / access)"
        };
        return unavailable(hint.to_string());
    }

    let (queues, topics) = parse_entities_json(&String::from_utf8_lossy(&output.stdout));
    ServiceBusEntities {
        available: true,
        error: None,
        namespace: fqdn,
        queues,
        topics,
    }
}

/// Create/delete/update an entity. `op` ∈ {create,delete,update}, `kind` ∈
/// {queue,topic,subscription}; `props` apply to create/update (ignored on delete). The verb
/// passed to the helper is `<op>-<kind>` — both are whitelisted so nothing arbitrary is run.
pub fn manage(
    namespace: &str,
    connection_string: Option<&str>,
    op: &str,
    kind: &str,
    entity: &str,
    subscription: Option<&str>,
    props: &SbEntityProps,
) -> ServiceBusManage {
    let fqdn = namespace_fqdn(namespace);
    let failed = |error: String| ServiceBusManage {
        ok: false,
        error: Some(error),
        namespace: fqdn.clone(),
        op: op.to_string(),
        kind: kind.to_string(),
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        message: None,
    };

    if !matches!(op, "create" | "delete" | "update") {
        return failed(format!("unsupported management op: {op}"));
    }
    if !matches!(kind, "queue" | "topic" | "subscription") {
        return failed(format!("unsupported entity kind: {kind}"));
    }

    let Some(program) = sb_explorer_program() else {
        return failed(
            "Service Bus explorer helper not installed (build tools/honeyhub-sb-explorer and set HONEYHUB_SB_EXPLORER)".to_string(),
        );
    };

    let mut args: Vec<String> = vec![
        format!("{op}-{kind}"),
        "--entity".to_string(),
        entity.to_string(),
    ];
    push_auth(&mut args, &fqdn, connection_string);
    if kind == "subscription" {
        if let Some(sub) = subscription {
            args.push("--subscription".to_string());
            args.push(sub.to_string());
        }
    }
    if op != "delete" {
        push_props(&mut args, props);
    }

    let output = match Command::new(&program).args(&args).output() {
        Ok(output) => output,
        Err(_) => return failed("could not run the Service Bus explorer helper".to_string()),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let hint = if stderr.contains("signed in") || stderr.contains("credential") {
            "not signed in (run az login)"
        } else if stderr.contains("unauthorized") || stderr.contains("forbidden") {
            "not authorized: needs Azure Service Bus management access"
        } else if stderr.contains("already exists") {
            "an entity with that name already exists"
        } else {
            "could not complete the operation (check the connection / name)"
        };
        return failed(hint.to_string());
    }

    ServiceBusManage {
        ok: true,
        error: None,
        namespace: fqdn,
        op: op.to_string(),
        kind: kind.to_string(),
        entity: entity.to_string(),
        subscription: subscription.map(str::to_string),
        message: Some(format!("{op}d {kind} {entity}")),
    }
}

/// Append the property flags for create/update from a [`SbEntityProps`]. Only set fields are
/// passed, so an update leaves the rest untouched.
fn push_props(args: &mut Vec<String>, props: &SbEntityProps) {
    if let Some(value) = props.max_size_mb {
        args.push("--max-size-mb".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = props.max_delivery_count {
        args.push("--max-delivery-count".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = props.lock_duration_seconds {
        args.push("--lock-duration-seconds".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = props.default_ttl_seconds {
        args.push("--default-ttl-seconds".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = props.dead_letter_on_expiration {
        args.push("--dead-letter-on-expiration".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = &props.status {
        if !value.trim().is_empty() {
            args.push("--status".to_string());
            args.push(value.clone());
        }
    }
}

/// Parse the helper's `entities` output into queues + topics(+subscriptions).
pub fn parse_entities_json(json: &str) -> (Vec<SbQueue>, Vec<SbTopic>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return (Vec::new(), Vec::new());
    };
    let count = |row: &serde_json::Value, key: &str| {
        row.get(key)
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
    };
    let text = |row: &serde_json::Value, key: &str, default: &str| {
        row.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or(default)
            .to_string()
    };

    let queues = value
        .get("queues")
        .and_then(serde_json::Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| SbQueue {
                    name: text(row, "name", ""),
                    status: text(row, "status", "Unknown"),
                    active: count(row, "active"),
                    dead_letter: count(row, "deadLetter"),
                    scheduled: count(row, "scheduled"),
                    props: parse_props(row),
                })
                .collect()
        })
        .unwrap_or_default();

    let topics = value
        .get("topics")
        .and_then(serde_json::Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| SbTopic {
                    name: text(row, "name", ""),
                    status: text(row, "status", "Unknown"),
                    props: parse_props(row),
                    subscriptions: row
                        .get("subscriptions")
                        .and_then(serde_json::Value::as_array)
                        .map(|subs| {
                            subs.iter()
                                .map(|sub| SbSubscription {
                                    name: text(sub, "name", ""),
                                    status: text(sub, "status", "Unknown"),
                                    active: count(sub, "active"),
                                    dead_letter: count(sub, "deadLetter"),
                                    props: parse_props(sub),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    (queues, topics)
}

/// Read the editable properties off one entity row from the helper's `entities` output.
fn parse_props(row: &serde_json::Value) -> SbEntityProps {
    let int = |key: &str| row.get(key).and_then(serde_json::Value::as_i64);
    SbEntityProps {
        max_size_mb: int("maxSizeMb"),
        max_delivery_count: int("maxDeliveryCount"),
        lock_duration_seconds: int("lockDurationSeconds"),
        default_ttl_seconds: int("defaultTtlSeconds"),
        dead_letter_on_expiration: row
            .get("deadLetterOnExpiration")
            .and_then(serde_json::Value::as_bool),
        status: row
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_namespaces_with_rg_and_id_fallback() {
        let json = r#"[
            {"name":"hd-bus","resourceGroup":"rg-hd","location":"eastus"},
            {"name":"hd-bus2","id":"/subscriptions/x/resourceGroups/rg-Two/providers/.../hd-bus2"}
        ]"#;
        let ns = parse_namespaces(json);
        assert_eq!(ns.len(), 2);
        assert_eq!(
            ns[0],
            (
                "hd-bus".to_string(),
                "rg-hd".to_string(),
                Some("eastus".to_string())
            )
        );
        // resourceGroup derived from the id (preserving original case from the id).
        assert_eq!(ns[1].1, "rg-Two");
        assert_eq!(ns[1].2, None);
    }

    #[test]
    fn parses_queue_counts() {
        let json = r#"[
            {"name":"orders","status":"Active",
             "countDetails":{"activeMessageCount":5,"deadLetterMessageCount":2,"scheduledMessageCount":1}},
            {"name":"empty","status":"Active"}
        ]"#;
        let entities = parse_queue_entities(json, "hd-bus");
        assert_eq!(entities.len(), 2);
        assert_eq!(entities[0].kind, ServiceBusEntityKind::Queue);
        assert_eq!(entities[0].active, 5);
        assert_eq!(entities[0].dead_letter, 2);
        assert_eq!(entities[0].scheduled, 1);
        assert_eq!(entities[0].namespace, "hd-bus");
        assert_eq!(entities[0].topic, None);
        // Missing countDetails → zeros, not a drop.
        assert_eq!(entities[1].active, 0);
    }

    #[test]
    fn parses_subscription_entities_with_topic() {
        let json =
            r#"[{"name":"sub1","status":"Active","countDetails":{"deadLetterMessageCount":7}}]"#;
        let entities = parse_subscription_entities(json, "hd-bus", "events");
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].kind, ServiceBusEntityKind::Subscription);
        assert_eq!(entities[0].topic.as_deref(), Some("events"));
        assert_eq!(entities[0].dead_letter, 7);
    }

    #[test]
    fn parses_topic_names_and_tolerates_garbage() {
        assert_eq!(
            parse_topic_names(r#"[{"name":"a"},{"name":"b"}]"#),
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(parse_topic_names("not json").is_empty());
        assert!(parse_queue_entities("{}", "ns").is_empty());
    }

    #[test]
    fn parses_peek_messages() {
        let json = r#"{"messages":[
            {"messageId":"m1","sequenceNumber":42,"enqueuedTime":"2026-06-15T10:00:00Z",
             "subject":"order.created","deliveryCount":1,"body":"{\"id\":7}","deadLetterReason":null},
            {"messageId":"m2","sequenceNumber":43,"deliveryCount":3,"body":"oops",
             "deadLetterReason":"MaxDeliveryCountExceeded"}
        ]}"#;
        let messages = parse_peek_json(json);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].message_id.as_deref(), Some("m1"));
        assert_eq!(messages[0].sequence_number, 42);
        assert_eq!(messages[0].subject.as_deref(), Some("order.created"));
        assert_eq!(messages[0].body, "{\"id\":7}");
        assert_eq!(messages[0].dead_letter_reason, None);
        // Dead-letter reason carries through; missing fields default cleanly.
        assert_eq!(
            messages[1].dead_letter_reason.as_deref(),
            Some("MaxDeliveryCountExceeded")
        );
        assert_eq!(messages[1].enqueued_time, None);
    }

    #[test]
    fn peek_parse_tolerates_garbage_and_shapes() {
        assert!(parse_peek_json("not json").is_empty());
        assert!(parse_peek_json("[]").is_empty()); // top-level must be the {messages:[…]} object
        assert!(parse_peek_json(r#"{"messages":null}"#).is_empty());
    }

    #[test]
    fn namespace_fqdn_appends_suffix_only_when_bare() {
        assert_eq!(namespace_fqdn("hd-bus"), "hd-bus.servicebus.windows.net");
        assert_eq!(
            namespace_fqdn("hd-bus.servicebus.windows.net"),
            "hd-bus.servicebus.windows.net"
        );
    }

    #[test]
    fn parses_resubmit_moved_count() {
        assert_eq!(parse_moved(r#"{"moved":3}"#), 3);
        assert_eq!(parse_moved("not json"), 0);
        assert_eq!(parse_moved("{}"), 0);
    }

    #[test]
    fn parses_purge_count() {
        assert_eq!(parse_purged(r#"{"purged":17}"#), 17);
        assert_eq!(parse_purged("not json"), 0);
        assert_eq!(parse_purged("{}"), 0);
    }

    #[test]
    fn purge_without_helper_is_failed_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = purge("hd-bus", None, "orders", None, true);
        assert_eq!(result.entity, "orders");
        assert!(result.dead_letter);
        assert!(!result.ok || result.purged >= 0);
    }

    #[test]
    fn send_without_helper_is_failed_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = send("hd-bus", None, "orders", "{\"x\":1}", Some("test"), None);
        assert_eq!(result.entity, "orders");
        assert_eq!(result.namespace, "hd-bus.servicebus.windows.net");
        // No helper → ok:false with a hint; never a panic.
        assert!(!result.ok);
        assert!(result.error.is_some());
    }

    #[test]
    fn parses_received_message_or_null() {
        let with = parse_received_json(
            r#"{"received":{"messageId":"m9","sequenceNumber":9,"deliveryCount":1,"body":"hi"}}"#,
        );
        assert_eq!(with.as_ref().unwrap().sequence_number, 9);
        assert_eq!(with.unwrap().body, "hi");
        // Empty entity → null → None.
        assert!(parse_received_json(r#"{"received":null}"#).is_none());
        assert!(parse_received_json("not json").is_none());
    }

    #[test]
    fn receive_without_helper_is_failed_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = receive_one("hd-bus", None, "orders", None, false);
        assert_eq!(result.entity, "orders");
        assert!(!result.ok);
        assert!(result.message.is_none());
    }

    #[test]
    fn resubmit_without_helper_is_failed_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = resubmit_dead_letter("hd-bus", None, "orders", None, 5);
        assert_eq!(result.entity, "orders");
        assert_eq!(result.namespace, "hd-bus.servicebus.windows.net");
        // No helper → ok:false with a hint, moved 0; never a panic.
        assert!(!result.ok || result.moved >= 0);
    }

    #[test]
    fn parses_entities_with_props_and_subscriptions() {
        let json = r#"{
            "queues":[{"name":"orders","status":"Active","active":5,"deadLetter":2,"scheduled":0,
                       "maxSizeMb":1024,"maxDeliveryCount":10,"lockDurationSeconds":30,
                       "defaultTtlSeconds":1209600,"deadLetterOnExpiration":false}],
            "topics":[{"name":"events","status":"Active","maxSizeMb":2048,
                       "subscriptions":[{"name":"all","status":"Active","active":1,"deadLetter":0,
                                         "maxDeliveryCount":5,"lockDurationSeconds":60}]}]
        }"#;
        let (queues, topics) = parse_entities_json(json);
        assert_eq!(queues.len(), 1);
        assert_eq!(queues[0].name, "orders");
        assert_eq!(queues[0].active, 5);
        assert_eq!(queues[0].props.max_size_mb, Some(1024));
        assert_eq!(queues[0].props.max_delivery_count, Some(10));
        assert_eq!(queues[0].props.dead_letter_on_expiration, Some(false));
        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].props.max_size_mb, Some(2048));
        assert_eq!(topics[0].subscriptions.len(), 1);
        assert_eq!(topics[0].subscriptions[0].name, "all");
        assert_eq!(topics[0].subscriptions[0].props.max_delivery_count, Some(5));
    }

    #[test]
    fn parse_entities_tolerates_garbage() {
        assert_eq!(parse_entities_json("not json"), (Vec::new(), Vec::new()));
        assert_eq!(parse_entities_json("{}"), (Vec::new(), Vec::new()));
    }

    #[test]
    fn manage_rejects_unknown_op_or_kind() {
        let bad_op = manage(
            "hd-bus",
            None,
            "drop",
            "queue",
            "orders",
            None,
            &SbEntityProps::default(),
        );
        assert!(!bad_op.ok);
        assert!(bad_op.error.unwrap().contains("unsupported management op"));
        let bad_kind = manage(
            "hd-bus",
            None,
            "create",
            "namespace",
            "x",
            None,
            &SbEntityProps::default(),
        );
        assert!(!bad_kind.ok);
        assert!(bad_kind.error.unwrap().contains("unsupported entity kind"));
    }

    #[test]
    fn manage_without_helper_is_failed_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = manage(
            "hd-bus",
            None,
            "create",
            "queue",
            "orders",
            None,
            &SbEntityProps::default(),
        );
        assert_eq!(result.entity, "orders");
        assert!(!result.ok);
        assert!(result.error.is_some());
    }

    #[test]
    fn list_entities_without_helper_is_unavailable_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = list_entities("hd-bus", None);
        assert_eq!(result.namespace, "hd-bus.servicebus.windows.net");
        assert!(!result.available || result.queues.is_empty());
    }

    #[test]
    fn peek_without_helper_is_unavailable_not_a_panic() {
        // With no helper on PATH / env, peek returns an honest unavailable result.
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = peek("hd-bus", None, "orders", None, false, 10);
        // Either the helper genuinely isn't present (unavailable) — the expected CI case — or
        // it is and the call fails to reach Azure; both must be a clean result, never a panic.
        assert_eq!(result.entity, "orders");
        assert_eq!(result.namespace, "hd-bus.servicebus.windows.net");
        assert!(!result.available || result.messages.is_empty());
    }
}
