//! **Azure Key Vault** connector (opt-in, read-only). Rides the operator's existing `az` sign-in
//! on the bridge host (like the Service Bus connector), so the cockpit, desktop or paired phone,
//! never holds an Azure credential. Management plane: list the operator's subscriptions
//! ([`subscriptions`]) and the Key Vaults across the selected ones ([`list_vaults`]). Data plane:
//! list a vault's secrets / keys / certificates metadata ([`list_vault_objects`]) and reveal a
//! single secret's value ([`reveal_secret`]). [`scan_expiring`] aggregates the objects-with-expiry
//! across the selected vaults for the background expiry notifications.

use crate::azcli::{resource_group_from_id, run_az};
use crate::backend_catalog::program_on_path;
use serde::{Deserialize, Serialize};

/// One Azure subscription the signed-in account can see (`az account list`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureSubscription {
    pub id: String,
    pub name: String,
    /// The CLI's current default subscription; the cockpit pre-selects it.
    pub is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    /// `Enabled` / `Disabled` etc., when reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

/// The subscription list, with an honest unavailable state (no `az` / not signed in).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureSubscriptionList {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub subscriptions: Vec<AzureSubscription>,
}

impl AzureSubscriptionList {
    fn unavailable(error: &str) -> Self {
        Self {
            available: false,
            error: Some(error.to_string()),
            subscriptions: Vec::new(),
        }
    }
}

/// One Key Vault (`az keyvault list`), tagged with the subscription it came from so a
/// multi-subscription view can group + correlate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyVault {
    pub name: String,
    pub resource_group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    pub subscription_id: String,
    /// The vault's data-plane URI (`https://<name>.vault.azure.net/`), when reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

/// The vaults across the selected subscriptions, with an honest unavailable state. `requested`
/// echoes the subscription ids the cockpit asked for, so the UI can ignore a stale response that
/// no longer matches the current selection (out-of-order responses).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyVaultList {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subscription_ids: Vec<String>,
    /// Selected subscriptions that could not be read (best-effort partial success): the cockpit
    /// surfaces these so a per-subscription access failure does not masquerade as "no vaults".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreadable: Vec<String>,
    pub vaults: Vec<KeyVault>,
}

impl KeyVaultList {
    fn unavailable(requested: &[String], error: &str) -> Self {
        Self {
            available: false,
            error: Some(error.to_string()),
            subscription_ids: requested.to_vec(),
            unreadable: Vec::new(),
            vaults: Vec::new(),
        }
    }

    fn ok(requested: &[String], unreadable: Vec<String>, vaults: Vec<KeyVault>) -> Self {
        Self {
            available: true,
            error: None,
            subscription_ids: requested.to_vec(),
            unreadable,
            vaults,
        }
    }
}

/// List the subscriptions the signed-in account can see, via `az account list`. Read-only. When
/// `az` is missing or not signed in, returns an unavailable list with a short hint rather than
/// failing; the caller surfaces it as "Key Vault: not signed in".
pub fn subscriptions() -> AzureSubscriptionList {
    if !program_on_path("az") {
        return AzureSubscriptionList::unavailable("Azure CLI (az) not found on PATH");
    }
    match run_az(&["account", "list", "-o", "json"]) {
        Ok(json) => AzureSubscriptionList {
            available: true,
            error: None,
            subscriptions: parse_subscriptions(&json),
        },
        Err(error) => AzureSubscriptionList::unavailable(&error),
    }
}

/// List the Key Vaults across `subscription_ids` via `az keyvault list --subscription <id>`.
/// Read-only (management plane only). The per-subscription reads are independent, so they run on
/// threads (subscriptions are few) to keep the snapshot responsive. Best-effort: a subscription
/// the operator can't read is skipped, not fatal, unless *every* one fails, in which case the
/// first error is surfaced so the cockpit can show "not signed in" rather than a false "no vaults".
pub fn list_vaults(subscription_ids: &[String]) -> KeyVaultList {
    if subscription_ids.is_empty() {
        // Nothing selected = nothing to query; an available, empty list (needs no `az`).
        return KeyVaultList::ok(subscription_ids, Vec::new(), Vec::new());
    }
    if !program_on_path("az") {
        return KeyVaultList::unavailable(subscription_ids, "Azure CLI (az) not found on PATH");
    }

    // Bound the fan-out: dedupe, drop obviously-invalid ids, and cap before spawning a thread + an
    // `az` process per one. The cockpit only ever sends its (small, valid, unique) selection, but
    // the paired client is not fully trusted, so a malformed or huge/duplicated list must not
    // exhaust the host. (A per-process timeout is the broader, cross-connector spawn_blocking work,
    // deferred here to stay consistent with the existing `az`/git/work connectors.)
    let to_query = bounded_unique(subscription_ids);

    let outcomes: Vec<Result<Vec<KeyVault>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = to_query
            .iter()
            .map(|sub| scope.spawn(move || vaults_for_subscription(sub)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err("the Key Vault read thread panicked".to_string()))
            })
            .collect()
    });

    // Pair each outcome with the subscription it came from (positional, same order as `to_query`)
    // so partial failures can be reported. Echo the ORIGINAL requested ids (not the deduped/capped
    // set) so the UI's stale-response guard still correlates a response with the selection it asked
    // for.
    let paired: Vec<(String, Result<Vec<KeyVault>, String>)> =
        to_query.into_iter().zip(outcomes).collect();
    merge_vault_outcomes(subscription_ids, paired)
}

/// Cap on how many subscriptions one request fans out to. A real operator account has a handful;
/// this bounds host work (one thread + one `az` process each) against a malformed/compromised
/// paired client sending a huge or duplicated list.
const MAX_SUBSCRIPTIONS: usize = 64;

/// Dedupe (preserving first-seen order), drop obviously-invalid ids, and cap the requested
/// subscription ids before fan-out.
fn bounded_unique(subscription_ids: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    subscription_ids
        .iter()
        .filter(|id| is_subscription_id_shaped(id))
        .filter(|id| seen.insert((*id).clone()))
        .take(MAX_SUBSCRIPTIONS)
        .cloned()
        .collect()
}

/// An Azure subscription id is a GUID. Cheap shape check (length, hyphen positions, hex digits) to
/// drop obvious garbage before shelling `az` for it; not a strict GUID validator.
fn is_subscription_id_shaped(id: &str) -> bool {
    if id.len() != 36 {
        return false;
    }
    id.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

/// Fold the per-subscription read outcomes into one list. Best-effort: keep every subscription
/// that succeeded and record the ones that failed (so the UI can warn); if *none* succeeded,
/// surface the first error so the cockpit shows "not signed in" rather than a false "no vaults".
/// Pure (no `az`), so the aggregation behavior is unit-tested.
fn merge_vault_outcomes(
    subscription_ids: &[String],
    outcomes: Vec<(String, Result<Vec<KeyVault>, String>)>,
) -> KeyVaultList {
    let mut vaults = Vec::new();
    let mut unreadable = Vec::new();
    let mut first_error: Option<String> = None;
    let mut any_ok = false;
    for (subscription_id, outcome) in outcomes {
        match outcome {
            Ok(found) => {
                any_ok = true;
                vaults.extend(found);
            }
            Err(error) => {
                unreadable.push(subscription_id);
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    if !any_ok {
        return KeyVaultList::unavailable(
            subscription_ids,
            &first_error.unwrap_or_else(|| "could not read Key Vaults".to_string()),
        );
    }
    KeyVaultList::ok(subscription_ids, unreadable, vaults)
}

/// Read one subscription's vaults. `Err` means that subscription could not be read (skipped
/// best-effort by the caller unless all fail).
fn vaults_for_subscription(subscription_id: &str) -> Result<Vec<KeyVault>, String> {
    let json = run_az(&[
        "keyvault",
        "list",
        "--subscription",
        subscription_id,
        "-o",
        "json",
    ])?;
    Ok(parse_vaults(&json, subscription_id))
}

/// Parse `az account list -o json` into subscriptions (rows missing an `id` are dropped).
pub fn parse_subscriptions(json: &str) -> Vec<AzureSubscription> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.to_string();
            let name = row
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_default = row
                .get("isDefault")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let tenant_id = opt_string(&row, "tenantId");
            let state = opt_string(&row, "state");
            Some(AzureSubscription {
                id,
                name,
                is_default,
                tenant_id,
                state,
            })
        })
        .collect()
}

/// Parse `az keyvault list --subscription <id> -o json` into vaults tagged with `subscription_id`.
pub fn parse_vaults(json: &str, subscription_id: &str) -> Vec<KeyVault> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let name = row.get("name")?.as_str()?.to_string();
            // `resourceGroup` is provided by az; fall back to deriving it from the id.
            let resource_group = row
                .get("resourceGroup")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| resource_group_from_id(row.get("id").and_then(|v| v.as_str())))
                .unwrap_or_default();
            let location = opt_string(&row, "location");
            let uri = row
                .get("properties")
                .and_then(|properties| properties.get("vaultUri"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            Some(KeyVault {
                name,
                resource_group,
                location,
                subscription_id: subscription_id.to_string(),
                uri,
            })
        })
        .collect()
}

/// A non-empty string field off a JSON object, or `None` (treats `""` as absent).
fn opt_string(row: &serde_json::Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

// --- Data-plane object listing + secret reveal (a vault's secrets / keys / certificates) ------

/// The kind of object inside a vault. Each has its own `az keyvault <kind> list` data-plane call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultObjectKind {
    Secret,
    Key,
    Certificate,
}

/// One secret / key / certificate's metadata (never its value). `expires` drives the cockpit's
/// expiry badges and the later expiry notifications; it is the `attributes.expires` instant
/// (ISO-8601 from the data-plane CLI, kept as a string so the UI can format / diff it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultObject {
    pub name: String,
    pub kind: VaultObjectKind,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    /// The secret's content type (secrets only), when set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

/// The objects inside one vault, with an honest unavailable state. `vault` + `subscription_id`
/// are echoed so the cockpit can correlate the response with the row it expanded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultObjects {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub vault: String,
    pub subscription_id: String,
    pub objects: Vec<VaultObject>,
}

impl VaultObjects {
    fn unavailable(vault: &str, subscription_id: &str, error: &str) -> Self {
        Self {
            available: false,
            error: Some(error.to_string()),
            vault: vault.to_string(),
            subscription_id: subscription_id.to_string(),
            objects: Vec::new(),
        }
    }
}

/// The result of revealing a single secret's value (the gated "view it" action). The `value` is
/// sensitive: it rides the local bridge on demand only, is never persisted host-side, and the
/// cockpit keeps it out of logs and storage.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretReveal {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub vault: String,
    pub subscription_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

// `Debug` is hand-written (not derived) so the plaintext secret `value` can never leak through a
// `{:?}` of this struct (or of any `BridgeEvent` that embeds it) into a log line; only its presence
// is shown.
impl std::fmt::Debug for SecretReveal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretReveal")
            .field("ok", &self.ok)
            .field("error", &self.error)
            .field("vault", &self.vault)
            .field("subscription_id", &self.subscription_id)
            .field("name", &self.name)
            .field("value", &self.value.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl SecretReveal {
    fn failed(vault: &str, subscription_id: &str, name: &str, error: &str) -> Self {
        Self {
            ok: false,
            error: Some(error.to_string()),
            vault: vault.to_string(),
            subscription_id: subscription_id.to_string(),
            name: name.to_string(),
            value: None,
        }
    }
}

/// List a vault's secrets, keys, and certificates (metadata only, never values), via the three
/// `az keyvault {secret,key,certificate} list` data-plane calls. Read-only. The three reads are
/// independent (and a vault may grant access to only some kinds), so they run on threads and fold
/// best-effort: include whatever kinds we can read; only when *all three* fail is the result
/// unavailable (surfacing the first error, e.g. not signed in / no access).
pub fn list_vault_objects(vault: &str, subscription_id: &str) -> VaultObjects {
    if !is_vault_name_shaped(vault) {
        return VaultObjects::unavailable(vault, subscription_id, "invalid vault name");
    }
    if !is_subscription_id_shaped(subscription_id) {
        return VaultObjects::unavailable(vault, subscription_id, "invalid subscription id");
    }
    if !program_on_path("az") {
        return VaultObjects::unavailable(
            vault,
            subscription_id,
            "Azure CLI (az) not found on PATH",
        );
    }

    let kinds = [
        VaultObjectKind::Secret,
        VaultObjectKind::Key,
        VaultObjectKind::Certificate,
    ];
    let outcomes: Vec<Result<Vec<VaultObject>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = kinds
            .iter()
            .map(|kind| scope.spawn(move || objects_of_kind(vault, subscription_id, *kind)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err("the Key Vault read thread panicked".to_string()))
            })
            .collect()
    });

    let mut objects = Vec::new();
    let mut first_error: Option<String> = None;
    let mut any_ok = false;
    for outcome in outcomes {
        match outcome {
            Ok(found) => {
                any_ok = true;
                objects.extend(found);
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    if !any_ok {
        return VaultObjects::unavailable(
            vault,
            subscription_id,
            &first_error.unwrap_or_else(|| "could not read the vault".to_string()),
        );
    }
    VaultObjects {
        available: true,
        error: None,
        vault: vault.to_string(),
        subscription_id: subscription_id.to_string(),
        objects,
    }
}

/// Read one object kind from a vault. `Err` means that kind could not be listed (skipped
/// best-effort by the caller unless all kinds fail).
fn objects_of_kind(
    vault: &str,
    subscription_id: &str,
    kind: VaultObjectKind,
) -> Result<Vec<VaultObject>, String> {
    let subcommand = match kind {
        VaultObjectKind::Secret => "secret",
        VaultObjectKind::Key => "key",
        VaultObjectKind::Certificate => "certificate",
    };
    let json = run_az(&[
        "keyvault",
        subcommand,
        "list",
        "--vault-name",
        vault,
        "--subscription",
        subscription_id,
        "-o",
        "json",
    ])?;
    Ok(parse_vault_objects(&json, kind))
}

/// Reveal a single secret's value via `az keyvault secret show` (the gated "view it" action).
/// Read-only. The value is read from the JSON `value` field so any content (newlines, tabs)
/// round-trips intact; honest failed states for not-found / no-access.
pub fn reveal_secret(vault: &str, subscription_id: &str, name: &str) -> SecretReveal {
    if !is_vault_name_shaped(vault) {
        return SecretReveal::failed(vault, subscription_id, name, "invalid vault name");
    }
    if !is_subscription_id_shaped(subscription_id) {
        return SecretReveal::failed(vault, subscription_id, name, "invalid subscription id");
    }
    // Validate the secret name shape too: it rides argv as `--name <name>`, so a leading `-`
    // could otherwise be parsed by `az` as a flag.
    if !is_object_name_shaped(name) {
        return SecretReveal::failed(vault, subscription_id, name, "invalid secret name");
    }
    if !program_on_path("az") {
        return SecretReveal::failed(
            vault,
            subscription_id,
            name,
            "Azure CLI (az) not found on PATH",
        );
    }
    match run_az(&[
        "keyvault",
        "secret",
        "show",
        "--vault-name",
        vault,
        "--name",
        name,
        "--subscription",
        subscription_id,
        "-o",
        "json",
    ]) {
        Ok(json) => match parse_secret_value(&json) {
            Some(value) => SecretReveal {
                ok: true,
                error: None,
                vault: vault.to_string(),
                subscription_id: subscription_id.to_string(),
                name: name.to_string(),
                value: Some(value),
            },
            None => SecretReveal::failed(vault, subscription_id, name, "the secret has no value"),
        },
        Err(error) => SecretReveal::failed(vault, subscription_id, name, &error),
    }
}

/// Parse `az keyvault <kind> list -o json` into objects. The name is the last path segment of the
/// object's `id` (secrets / certificates) or `kid` (keys); rows without one are dropped.
pub fn parse_vault_objects(json: &str, kind: VaultObjectKind) -> Vec<VaultObject> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    rows.into_iter()
        .filter_map(|row| {
            let id = row
                .get("id")
                .or_else(|| row.get("kid"))
                .and_then(|v| v.as_str())?;
            let name = id.rsplit('/').next().unwrap_or("").to_string();
            if name.is_empty() {
                return None;
            }
            let attributes = row.get("attributes");
            // `enabled` defaults to true to match Key Vault's own default for the attribute when it
            // is absent from a row.
            let enabled = attributes
                .and_then(|a| a.get("enabled"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            Some(VaultObject {
                name,
                kind,
                enabled,
                expires: attr_instant(attributes, "expires"),
                created: attr_instant(attributes, "created"),
                updated: attr_instant(attributes, "updated"),
                // `contentType` is a secret-only attribute; ignore any stray value on keys/certs.
                content_type: match kind {
                    VaultObjectKind::Secret => opt_string(&row, "contentType"),
                    _ => None,
                },
            })
        })
        .collect()
}

/// Parse the `value` out of `az keyvault secret show -o json`.
pub fn parse_secret_value(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()?
        .get("value")?
        .as_str()
        .map(str::to_string)
}

/// Read an `attributes.<key>` instant. The data-plane CLI renders these as ISO-8601 strings; this
/// also tolerates a raw numeric (unix-seconds) form, surfaced as its digits so the UI can detect
/// and convert it. `null` / absent → `None`.
fn attr_instant(attributes: Option<&serde_json::Value>, key: &str) -> Option<String> {
    let value = attributes?.get(key)?;
    if let Some(text) = value.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    value.as_i64().map(|seconds| seconds.to_string())
}

/// A Key Vault name (3-24 chars, starts with a letter, alphanumeric + hyphens). A light shape
/// check to drop obvious garbage before it rides argv as `--vault-name`.
fn is_vault_name_shaped(vault: &str) -> bool {
    let bytes = vault.as_bytes();
    (3..=24).contains(&vault.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
}

/// A secret/key/certificate name shape (1-127 chars, alphanumeric + hyphens, no leading hyphen),
/// so a name can ride argv as `--name` without being mistaken for a flag.
fn is_object_name_shaped(name: &str) -> bool {
    (1..=127).contains(&name.len())
        && !name.starts_with('-')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

// --- Expiry scan (for background expiry notifications) ------------------------------------------

/// One secret / key / certificate that carries an expiry, with the vault + subscription it lives
/// in. The cockpit's notification engine filters these by its configurable threshold and fires
/// once per item; `expires` is always present (only objects with an expiry are scanned).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpiringObject {
    pub vault: String,
    pub subscription_id: String,
    pub kind: VaultObjectKind,
    pub name: String,
    pub expires: String,
}

/// The objects-with-an-expiry across the selected subscriptions' vaults, with an honest
/// unavailable state. The bridge does no date math; it just aggregates, and the UI applies the
/// "within N days" threshold (it owns the clock + the operator's setting).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpiringObjects {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// True when the account has more vaults than the scan cap, so coverage is incomplete. The
    /// cockpit surfaces this so an operator with many vaults is not misled into thinking "no
    /// alert" means "nothing expiring".
    #[serde(default)]
    pub truncated: bool,
    pub objects: Vec<ExpiringObject>,
}

impl ExpiringObjects {
    fn unavailable(error: &str) -> Self {
        Self {
            available: false,
            error: Some(error.to_string()),
            truncated: false,
            objects: Vec::new(),
        }
    }
}

/// Cap on how many vaults one expiry scan walks (each vault is three `az` list calls). Bounds the
/// background scan's host work against a very large account.
const MAX_SCAN_VAULTS: usize = 100;

/// Scan every vault across `subscription_ids` for objects that carry an expiry, for the background
/// expiry notifications. Read-only. Reuses [`list_vaults`] + [`list_vault_objects`] (so it inherits
/// their validation, bounded fan-out, and best-effort access handling); a vault or kind that can't
/// be read is simply skipped. Returns only objects with an `expires` set; the UI does the
/// threshold + clock math. Heavy (many `az` calls), so the caller polls it on a long cadence.
pub fn scan_expiring(subscription_ids: &[String]) -> ExpiringObjects {
    let vaults = list_vaults(subscription_ids);
    if !vaults.available {
        return ExpiringObjects::unavailable(
            &vaults
                .error
                .unwrap_or_else(|| "could not read Key Vaults".to_string()),
        );
    }

    let had_vaults = !vaults.vaults.is_empty();
    // The account has more vaults than we will walk this scan: coverage is incomplete.
    let truncated = vaults.vaults.len() > MAX_SCAN_VAULTS;
    let listings: Vec<VaultObjects> = vaults
        .vaults
        .iter()
        .take(MAX_SCAN_VAULTS)
        .map(|vault| list_vault_objects(&vault.name, &vault.subscription_id))
        .collect();
    aggregate_expiring(had_vaults, truncated, listings)
}

/// Fold per-vault listings into the expiring set: keep every object that carries an `expires`,
/// tagged with the vault + subscription its listing echoed. If the account `had_vaults` but none
/// of their listings were readable (e.g. a transient data-plane access loss), report unavailable
/// rather than a false "nothing expiring", so the cockpit keeps its prior alerted-set instead of
/// resetting it and re-firing on restore. Pure (no `az`), so the aggregation is unit-tested.
fn aggregate_expiring(
    had_vaults: bool,
    truncated: bool,
    listings: Vec<VaultObjects>,
) -> ExpiringObjects {
    let mut objects = Vec::new();
    let mut any_vault_read = false;
    for listing in listings {
        if !listing.available {
            continue;
        }
        any_vault_read = true;
        let vault = listing.vault;
        let subscription_id = listing.subscription_id;
        for object in listing.objects {
            if let Some(expires) = object.expires {
                objects.push(ExpiringObject {
                    vault: vault.clone(),
                    subscription_id: subscription_id.clone(),
                    kind: object.kind,
                    name: object.name,
                    expires,
                });
            }
        }
    }

    if had_vaults && !any_vault_read {
        return ExpiringObjects::unavailable("could not read any vault's contents");
    }
    ExpiringObjects {
        available: true,
        error: None,
        truncated,
        objects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_subscriptions_with_default_and_optional_fields() {
        let json = r#"[
            {"id":"sub-1","name":"Dev","isDefault":true,"tenantId":"t-1","state":"Enabled"},
            {"id":"sub-2","name":"Prod","isDefault":false}
        ]"#;
        let subs = parse_subscriptions(json);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].id, "sub-1");
        assert_eq!(subs[0].name, "Dev");
        assert!(subs[0].is_default);
        assert_eq!(subs[0].tenant_id.as_deref(), Some("t-1"));
        assert_eq!(subs[0].state.as_deref(), Some("Enabled"));
        // Missing optionals default cleanly; not-default is false.
        assert!(!subs[1].is_default);
        assert_eq!(subs[1].tenant_id, None);
        assert_eq!(subs[1].state, None);
    }

    #[test]
    fn subscriptions_parse_drops_rows_without_id_and_tolerates_garbage() {
        assert!(parse_subscriptions(r#"[{"name":"no id"}]"#).is_empty());
        assert!(parse_subscriptions("not json").is_empty());
        assert!(parse_subscriptions("{}").is_empty());
    }

    #[test]
    fn parses_vaults_with_rg_id_fallback_and_uri() {
        let json = r#"[
            {"name":"kv-dev","resourceGroup":"rg-hd","location":"eastus",
             "properties":{"vaultUri":"https://kv-dev.vault.azure.net/"}},
            {"name":"kv-two","location":"",
             "id":"/subscriptions/x/resourceGroups/rg-Two/providers/Microsoft.KeyVault/vaults/kv-two"}
        ]"#;
        let vaults = parse_vaults(json, "sub-1");
        assert_eq!(vaults.len(), 2);
        assert_eq!(vaults[0].name, "kv-dev");
        assert_eq!(vaults[0].resource_group, "rg-hd");
        assert_eq!(vaults[0].location.as_deref(), Some("eastus"));
        assert_eq!(vaults[0].subscription_id, "sub-1");
        assert_eq!(
            vaults[0].uri.as_deref(),
            Some("https://kv-dev.vault.azure.net/")
        );
        // resourceGroup derived from the id (case preserved); empty location → None; no uri.
        assert_eq!(vaults[1].resource_group, "rg-Two");
        assert_eq!(vaults[1].location, None);
        assert_eq!(vaults[1].uri, None);
    }

    #[test]
    fn vaults_parse_tolerates_garbage() {
        assert!(parse_vaults("not json", "sub-1").is_empty());
        assert!(parse_vaults("{}", "sub-1").is_empty());
        assert!(parse_vaults(r#"[{"noName":1}]"#, "sub-1").is_empty());
    }

    #[test]
    fn list_vaults_with_no_subscriptions_is_available_and_empty() {
        // No subscriptions selected = nothing to query; an available, empty list (not an error).
        // Guarded before any `az` call, so this is deterministic whether or not `az` is on PATH.
        let list = list_vaults(&[]);
        assert!(list.available);
        assert!(list.vaults.is_empty());
        assert_eq!(list.error, None);
        assert!(list.subscription_ids.is_empty());
    }

    fn vault(name: &str, sub: &str) -> KeyVault {
        KeyVault {
            name: name.to_string(),
            resource_group: "rg".to_string(),
            location: None,
            subscription_id: sub.to_string(),
            uri: None,
        }
    }

    #[test]
    fn merge_outcomes_aggregates_all_successful_subscriptions() {
        let requested = vec!["a".to_string(), "b".to_string()];
        let merged = merge_vault_outcomes(
            &requested,
            vec![
                ("a".to_string(), Ok(vec![vault("kv1", "a")])),
                ("b".to_string(), Ok(vec![vault("kv2", "b")])),
            ],
        );
        assert!(merged.available);
        assert_eq!(merged.error, None);
        assert_eq!(merged.vaults.len(), 2);
        assert!(merged.unreadable.is_empty());
        // The requested set is echoed for the UI's stale-response guard.
        assert_eq!(merged.subscription_ids, requested);
    }

    #[test]
    fn merge_outcomes_keeps_partial_success_and_records_unreadable() {
        let requested = vec!["a".to_string(), "b".to_string()];
        let merged = merge_vault_outcomes(
            &requested,
            vec![
                ("a".to_string(), Ok(vec![vault("kv1", "a")])),
                (
                    "b".to_string(),
                    Err("no access to subscription b".to_string()),
                ),
            ],
        );
        // One subscription failed, one succeeded: best-effort keeps the vaults we could read and
        // reports the unreadable subscription so the UI can warn (not a silent "no vaults").
        assert!(merged.available);
        assert_eq!(merged.error, None);
        assert_eq!(merged.vaults.len(), 1);
        assert_eq!(merged.vaults[0].name, "kv1");
        assert_eq!(merged.unreadable, vec!["b".to_string()]);
    }

    #[test]
    fn merge_outcomes_surfaces_first_error_when_all_fail() {
        let requested = vec!["a".to_string(), "b".to_string()];
        let merged = merge_vault_outcomes(
            &requested,
            vec![
                (
                    "a".to_string(),
                    Err("Azure CLI is not signed in (run `az login`)".to_string()),
                ),
                ("b".to_string(), Err("second error".to_string())),
            ],
        );
        // Every subscription failed: unavailable, surfacing the FIRST error (not "no vaults").
        assert!(!merged.available);
        assert_eq!(
            merged.error.as_deref(),
            Some("Azure CLI is not signed in (run `az login`)")
        );
        assert!(merged.vaults.is_empty());
        assert_eq!(merged.subscription_ids, requested);
    }

    #[test]
    fn bounded_unique_dedupes_preserving_order_caps_and_drops_garbage() {
        // A GUID-shaped subscription id for the given low value.
        let guid = |n: u32| format!("00000000-0000-0000-0000-{n:012x}");

        // Duplicates collapse to first-seen; order preserved.
        let ids = vec![guid(0xb), guid(0xa), guid(0xb), guid(0xc), guid(0xa)];
        assert_eq!(bounded_unique(&ids), vec![guid(0xb), guid(0xa), guid(0xc)]);

        // Obvious garbage (not GUID-shaped) is dropped before any `az` fan-out.
        let mixed = vec!["not-a-guid".to_string(), guid(0xa)];
        assert_eq!(bounded_unique(&mixed), vec![guid(0xa)]);

        // A pathological huge list is capped to MAX_SUBSCRIPTIONS.
        let many: Vec<String> = (0..1000).map(guid).collect();
        let bounded = bounded_unique(&many);
        assert_eq!(bounded.len(), MAX_SUBSCRIPTIONS);
        assert_eq!(bounded[0], guid(0));
    }

    #[test]
    fn subscription_id_shape_check_accepts_guids_and_rejects_garbage() {
        assert!(is_subscription_id_shaped(
            "00000000-0000-0000-0000-000000000001"
        ));
        assert!(is_subscription_id_shaped(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        ));
        assert!(!is_subscription_id_shaped("not-a-guid"));
        assert!(!is_subscription_id_shaped("")); // wrong length
        assert!(!is_subscription_id_shaped(
            "00000000-0000-0000-0000-00000000000g" // non-hex digit
        ));
        // 36 chars but no hyphens at positions 8/13/18/23 (all hex) → wrong shape.
        assert!(!is_subscription_id_shaped(
            "000000000000000000000000000000000000"
        ));
    }

    #[test]
    fn merge_outcomes_with_empty_outcomes_is_unavailable() {
        // Defensive: no outcomes at all (e.g. a join folding) is treated as all-fail.
        let merged = merge_vault_outcomes(&["a".to_string()], Vec::new());
        assert!(!merged.available);
        assert_eq!(merged.error.as_deref(), Some("could not read Key Vaults"));
    }

    #[test]
    fn parses_secret_objects_with_name_from_id_and_iso_expiry() {
        let json = r#"[
            {"id":"https://kv.vault.azure.net/secrets/db-password",
             "attributes":{"enabled":true,"expires":"2026-07-01T00:00:00+00:00",
                           "created":"2026-01-01T00:00:00+00:00","updated":"2026-02-01T00:00:00+00:00"},
             "contentType":"password"},
            {"id":"https://kv.vault.azure.net/secrets/disabled-one",
             "attributes":{"enabled":false}}
        ]"#;
        let objects = parse_vault_objects(json, VaultObjectKind::Secret);
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].name, "db-password");
        assert_eq!(objects[0].kind, VaultObjectKind::Secret);
        assert!(objects[0].enabled);
        assert_eq!(
            objects[0].expires.as_deref(),
            Some("2026-07-01T00:00:00+00:00")
        );
        assert_eq!(objects[0].content_type.as_deref(), Some("password"));
        // Missing attributes default cleanly; disabled is honored.
        assert!(!objects[1].enabled);
        assert_eq!(objects[1].expires, None);
        assert_eq!(objects[1].content_type, None);
    }

    #[test]
    fn parses_key_objects_from_kid_and_numeric_expiry() {
        // Keys carry `kid` (not `id`); a numeric (unix-seconds) expiry is surfaced as its digits.
        let json = r#"[{"kid":"https://kv.vault.azure.net/keys/signing-key",
                        "attributes":{"enabled":true,"expires":1751328000}}]"#;
        let objects = parse_vault_objects(json, VaultObjectKind::Key);
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].name, "signing-key");
        assert_eq!(objects[0].kind, VaultObjectKind::Key);
        assert_eq!(objects[0].expires.as_deref(), Some("1751328000"));
    }

    #[test]
    fn parses_certificate_objects_and_tolerates_garbage() {
        let json = r#"[{"id":"https://kv.vault.azure.net/certificates/tls-cert",
                        "attributes":{"enabled":true}}]"#;
        let objects = parse_vault_objects(json, VaultObjectKind::Certificate);
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].name, "tls-cert");
        assert_eq!(objects[0].kind, VaultObjectKind::Certificate);
        // Garbage / missing id rows are dropped.
        assert!(parse_vault_objects("not json", VaultObjectKind::Secret).is_empty());
        assert!(parse_vault_objects(r#"[{"noId":1}]"#, VaultObjectKind::Secret).is_empty());
    }

    #[test]
    fn secret_reveal_debug_redacts_the_plaintext_value() {
        let revealed = SecretReveal {
            ok: true,
            error: None,
            vault: "kv".to_string(),
            subscription_id: "sub".to_string(),
            name: "db-password".to_string(),
            value: Some("super-secret-value".to_string()),
        };
        let debug = format!("{revealed:?}");
        // The plaintext never appears via `{:?}`; only its presence is shown.
        assert!(!debug.contains("super-secret-value"));
        assert!(debug.contains("<redacted>"));
        // Non-sensitive fields stay visible for diagnostics.
        assert!(debug.contains("db-password"));
    }

    #[test]
    fn content_type_is_kept_for_secrets_and_dropped_for_keys() {
        let json = r#"[{"id":"https://kv.vault.azure.net/keys/k","attributes":{"enabled":true},
                        "contentType":"stray"}]"#;
        // A stray contentType on a key is ignored (it is a secret-only attribute).
        let keys = parse_vault_objects(json, VaultObjectKind::Key);
        assert_eq!(keys[0].content_type, None);
    }

    #[test]
    fn parses_secret_value_or_none() {
        assert_eq!(
            parse_secret_value(r#"{"id":"x","value":"s3cr3t","attributes":{}}"#).as_deref(),
            Some("s3cr3t")
        );
        // A value with newlines round-trips intact (JSON, not tsv).
        assert_eq!(
            parse_secret_value(r#"{"value":"line1\nline2"}"#).as_deref(),
            Some("line1\nline2")
        );
        assert_eq!(parse_secret_value("{}"), None);
        assert_eq!(parse_secret_value("not json"), None);
    }

    #[test]
    fn name_shape_checks_reject_argv_injection_and_garbage() {
        assert!(is_vault_name_shaped("kv-honeydrunk-dev"));
        assert!(!is_vault_name_shaped("-kv")); // can't start with a hyphen
        assert!(!is_vault_name_shaped("ab")); // too short
        assert!(!is_vault_name_shaped("kv name")); // space

        assert!(is_object_name_shaped("db-password"));
        assert!(!is_object_name_shaped("--query")); // leading hyphen (flag injection)
        assert!(!is_object_name_shaped("")); // empty
        assert!(!is_object_name_shaped("name with space"));
    }

    #[test]
    fn reveal_secret_rejects_invalid_input_without_shelling_az() {
        // Deterministic (no `az` call): bad vault / subscription / secret names fail fast, and the
        // result echoes the requested vault + subscription + name back for UI correlation.
        let sub = "00000000-0000-0000-0000-000000000001";
        let bad_vault = reveal_secret("-bad", sub, "name");
        assert!(!bad_vault.ok);
        assert_eq!(bad_vault.error.as_deref(), Some("invalid vault name"));
        assert_eq!(bad_vault.subscription_id, sub);

        let bad_sub = reveal_secret("kv-honeydrunk-dev", "not-a-guid", "name");
        assert_eq!(bad_sub.error.as_deref(), Some("invalid subscription id"));

        // A valid subscription id reaches the secret-name check; a leading-hyphen name is rejected.
        let bad_name = reveal_secret("kv-honeydrunk-dev", sub, "--query");
        assert!(!bad_name.ok);
        assert_eq!(bad_name.error.as_deref(), Some("invalid secret name"));
    }

    #[test]
    fn list_vault_objects_rejects_invalid_input_without_shelling_az() {
        let bad_vault = list_vault_objects("-bad", "00000000-0000-0000-0000-000000000001");
        assert!(!bad_vault.available);
        assert_eq!(bad_vault.error.as_deref(), Some("invalid vault name"));
        assert_eq!(bad_vault.vault, "-bad");

        let bad_sub = list_vault_objects("kv-honeydrunk-dev", "not-a-guid");
        assert!(!bad_sub.available);
        assert_eq!(bad_sub.error.as_deref(), Some("invalid subscription id"));
        assert_eq!(bad_sub.subscription_id, "not-a-guid");
    }

    #[test]
    fn scan_expiring_with_no_subscriptions_is_available_and_empty() {
        // No subscriptions selected: list_vaults short-circuits to an available, empty list (no
        // `az`), so the scan is deterministically available with nothing to report.
        let scan = scan_expiring(&[]);
        assert!(scan.available);
        assert!(scan.objects.is_empty());
        assert_eq!(scan.error, None);
    }

    fn object_with_expiry(name: &str, expires: Option<&str>) -> VaultObject {
        VaultObject {
            name: name.to_string(),
            kind: VaultObjectKind::Secret,
            enabled: true,
            expires: expires.map(str::to_string),
            created: None,
            updated: None,
            content_type: None,
        }
    }

    fn listing(vault: &str, sub: &str, available: bool, objects: Vec<VaultObject>) -> VaultObjects {
        VaultObjects {
            available,
            error: if available {
                None
            } else {
                Some("no access".to_string())
            },
            vault: vault.to_string(),
            subscription_id: sub.to_string(),
            objects,
        }
    }

    #[test]
    fn aggregate_expiring_keeps_objects_with_expiry_tagged_by_vault() {
        let listings = vec![
            listing(
                "kv-a",
                "sub-1",
                true,
                vec![
                    object_with_expiry("with-exp", Some("2026-07-01T00:00:00+00:00")),
                    object_with_expiry("no-exp", None),
                ],
            ),
            listing(
                "kv-b",
                "sub-1",
                true,
                vec![object_with_expiry("k", Some("2026-08-01T00:00:00+00:00"))],
            ),
        ];
        let result = aggregate_expiring(true, false, listings);
        assert!(result.available);
        // Only objects WITH an expiry are kept, tagged with their vault + subscription.
        assert_eq!(result.objects.len(), 2);
        assert_eq!(result.objects[0].name, "with-exp");
        assert_eq!(result.objects[0].vault, "kv-a");
        assert_eq!(result.objects[0].subscription_id, "sub-1");
        assert_eq!(result.objects[1].vault, "kv-b");
    }

    #[test]
    fn aggregate_expiring_partial_keeps_readable_and_stays_available() {
        // One vault readable, one not: best-effort keeps what we could read, still available.
        let listings = vec![
            listing(
                "kv-a",
                "sub-1",
                true,
                vec![object_with_expiry("x", Some("2026-07-01T00:00:00+00:00"))],
            ),
            listing("kv-b", "sub-1", false, Vec::new()),
        ];
        let result = aggregate_expiring(true, false, listings);
        assert!(result.available);
        assert_eq!(result.objects.len(), 1);
    }

    #[test]
    fn aggregate_expiring_is_unavailable_when_no_vault_is_readable() {
        // Had vaults, but none readable: unavailable, so the UI keeps its prior alerted-set.
        let listings = vec![
            listing("kv-a", "sub-1", false, Vec::new()),
            listing("kv-b", "sub-1", false, Vec::new()),
        ];
        let result = aggregate_expiring(true, false, listings);
        assert!(!result.available);
        assert_eq!(
            result.error.as_deref(),
            Some("could not read any vault's contents")
        );
    }

    #[test]
    fn aggregate_expiring_with_no_vaults_is_available_and_empty() {
        let result = aggregate_expiring(false, false, Vec::new());
        assert!(result.available);
        assert!(result.objects.is_empty());
        assert_eq!(result.error, None);
        assert!(!result.truncated);
    }

    #[test]
    fn aggregate_expiring_propagates_the_truncated_flag() {
        let listings = vec![listing(
            "kv-a",
            "sub-1",
            true,
            vec![object_with_expiry("x", Some("2026-07-01T00:00:00+00:00"))],
        )];
        let result = aggregate_expiring(true, true, listings);
        assert!(result.available);
        assert!(result.truncated);
        assert_eq!(result.objects.len(), 1);
    }
}
