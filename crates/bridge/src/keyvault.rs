//! **Azure Key Vault** connector (opt-in, read-only). Rides the operator's existing `az` sign-in
//! on the bridge host (like the Service Bus connector), so the cockpit, desktop or paired phone,
//! never holds an Azure credential. This first slice is management-plane only: list the operator's
//! subscriptions ([`subscriptions`]) for the picker, then list the Key Vaults across the selected
//! subscriptions ([`list_vaults`]). Browsing secret/key/certificate metadata + values, and the
//! expiry alerts, ride the same `az` path in later slices.

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
    pub vaults: Vec<KeyVault>,
}

impl KeyVaultList {
    fn unavailable(requested: &[String], error: &str) -> Self {
        Self {
            available: false,
            error: Some(error.to_string()),
            subscription_ids: requested.to_vec(),
            vaults: Vec::new(),
        }
    }

    fn ok(requested: &[String], vaults: Vec<KeyVault>) -> Self {
        Self {
            available: true,
            error: None,
            subscription_ids: requested.to_vec(),
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
        return KeyVaultList::ok(subscription_ids, Vec::new());
    }
    if !program_on_path("az") {
        return KeyVaultList::unavailable(subscription_ids, "Azure CLI (az) not found on PATH");
    }

    // Bound the fan-out: dedupe + cap the requested ids before spawning a thread + an `az` process
    // per one. The cockpit only ever sends its (small, unique) selection, but the paired client is
    // not fully trusted, so a malformed or huge/duplicated list must not exhaust the host.
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

    // Echo the ORIGINAL requested ids (not the deduped/capped set) so the UI's stale-response
    // guard still correlates a response with the exact selection it asked for.
    merge_vault_outcomes(subscription_ids, outcomes)
}

/// Cap on how many subscriptions one request fans out to. A real operator account has a handful;
/// this bounds host work (one thread + one `az` process each) against a malformed/compromised
/// paired client sending a huge or duplicated list.
const MAX_SUBSCRIPTIONS: usize = 64;

/// Dedupe (preserving first-seen order) and cap the requested subscription ids before fan-out.
fn bounded_unique(subscription_ids: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    subscription_ids
        .iter()
        .filter(|id| seen.insert((*id).clone()))
        .take(MAX_SUBSCRIPTIONS)
        .cloned()
        .collect()
}

/// Fold the per-subscription read outcomes into one list. Best-effort: keep every subscription
/// that succeeded; if *none* did, surface the first error so the cockpit shows "not signed in"
/// rather than a false "no vaults". Pure (no `az`), so the aggregation behavior is unit-tested.
fn merge_vault_outcomes(
    subscription_ids: &[String],
    outcomes: Vec<Result<Vec<KeyVault>, String>>,
) -> KeyVaultList {
    let mut vaults = Vec::new();
    let mut first_error: Option<String> = None;
    let mut any_ok = false;
    for outcome in outcomes {
        match outcome {
            Ok(found) => {
                any_ok = true;
                vaults.extend(found);
            }
            Err(error) => {
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
    KeyVaultList::ok(subscription_ids, vaults)
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
            vec![Ok(vec![vault("kv1", "a")]), Ok(vec![vault("kv2", "b")])],
        );
        assert!(merged.available);
        assert_eq!(merged.error, None);
        assert_eq!(merged.vaults.len(), 2);
        // The requested set is echoed for the UI's stale-response guard.
        assert_eq!(merged.subscription_ids, requested);
    }

    #[test]
    fn merge_outcomes_keeps_partial_success_and_does_not_error() {
        let requested = vec!["a".to_string(), "b".to_string()];
        let merged = merge_vault_outcomes(
            &requested,
            vec![
                Ok(vec![vault("kv1", "a")]),
                Err("no access to subscription b".to_string()),
            ],
        );
        // One subscription failed, one succeeded: best-effort keeps the vaults we could read.
        assert!(merged.available);
        assert_eq!(merged.error, None);
        assert_eq!(merged.vaults.len(), 1);
        assert_eq!(merged.vaults[0].name, "kv1");
    }

    #[test]
    fn merge_outcomes_surfaces_first_error_when_all_fail() {
        let requested = vec!["a".to_string(), "b".to_string()];
        let merged = merge_vault_outcomes(
            &requested,
            vec![
                Err("Azure CLI is not signed in (run `az login`)".to_string()),
                Err("second error".to_string()),
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
    fn bounded_unique_dedupes_preserving_order_and_caps() {
        // Duplicates collapse to first-seen; order preserved.
        let ids = vec![
            "b".to_string(),
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "a".to_string(),
        ];
        assert_eq!(
            bounded_unique(&ids),
            vec!["b".to_string(), "a".to_string(), "c".to_string()]
        );

        // A pathological huge list is capped to MAX_SUBSCRIPTIONS.
        let many: Vec<String> = (0..1000).map(|n| n.to_string()).collect();
        let bounded = bounded_unique(&many);
        assert_eq!(bounded.len(), MAX_SUBSCRIPTIONS);
        assert_eq!(bounded[0], "0");
    }

    #[test]
    fn merge_outcomes_with_empty_outcomes_is_unavailable() {
        // Defensive: no outcomes at all (e.g. a join folding) is treated as all-fail.
        let merged = merge_vault_outcomes(&["a".to_string()], Vec::new());
        assert!(!merged.available);
        assert_eq!(merged.error.as_deref(), Some("could not read Key Vaults"));
    }
}
