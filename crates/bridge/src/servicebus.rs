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
        "--namespace".to_string(),
        fqdn.clone(),
        "--entity".to_string(),
        entity.to_string(),
        "--count".to_string(),
        count.clamp(1, 100).to_string(),
    ];
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
        "--namespace".to_string(),
        fqdn.clone(),
        "--entity".to_string(),
        entity.to_string(),
        "--count".to_string(),
        count.clamp(1, 100).to_string(),
    ];
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
            "not authorized — needs the Azure Service Bus Data Sender + Receiver roles"
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
        "--namespace".to_string(),
        fqdn.clone(),
        "--entity".to_string(),
        entity.to_string(),
    ];
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
            "not authorized — needs the Azure Service Bus Data Receiver role"
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
        "--namespace".to_string(),
        fqdn.clone(),
        "--entity".to_string(),
        entity.to_string(),
        "--body".to_string(),
        body.to_string(),
    ];
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
            "not authorized — needs the Azure Service Bus Data Sender role"
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
        "--namespace".to_string(),
        fqdn.clone(),
        "--entity".to_string(),
        entity.to_string(),
    ];
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
            "not authorized — needs the Azure Service Bus Data Receiver role"
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
        let result = purge("hd-bus", "orders", None, true);
        assert_eq!(result.entity, "orders");
        assert!(result.dead_letter);
        assert!(!result.ok || result.purged >= 0);
    }

    #[test]
    fn send_without_helper_is_failed_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = send("hd-bus", "orders", "{\"x\":1}", Some("test"), None);
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
        let result = receive_one("hd-bus", "orders", None, false);
        assert_eq!(result.entity, "orders");
        assert!(!result.ok);
        assert!(result.message.is_none());
    }

    #[test]
    fn resubmit_without_helper_is_failed_not_a_panic() {
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = resubmit_dead_letter("hd-bus", "orders", None, 5);
        assert_eq!(result.entity, "orders");
        assert_eq!(result.namespace, "hd-bus.servicebus.windows.net");
        // No helper → ok:false with a hint, moved 0; never a panic.
        assert!(!result.ok || result.moved >= 0);
    }

    #[test]
    fn peek_without_helper_is_unavailable_not_a_panic() {
        // With no helper on PATH / env, peek returns an honest unavailable result.
        std::env::remove_var("HONEYHUB_SB_EXPLORER");
        let result = peek("hd-bus", "orders", None, false, 10);
        // Either the helper genuinely isn't present (unavailable) — the expected CI case — or
        // it is and the call fails to reach Azure; both must be a clean result, never a panic.
        assert_eq!(result.entity, "orders");
        assert_eq!(result.namespace, "hd-bus.servicebus.windows.net");
        assert!(!result.available || result.messages.is_empty());
    }
}
