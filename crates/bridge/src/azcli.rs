//! Thin shared wrapper around the **Azure CLI** (`az`) for the read-only Azure connectors
//! (Service Bus, Key Vault, …). Every Azure connector runs `az` on the bridge host, riding the
//! operator's existing `az login`, so the cockpit (desktop or the paired phone) never holds an
//! Azure credential itself. Failures are sanitized to a short hint; raw `az` stderr can carry
//! subscription ids / resource paths, so it is never surfaced verbatim.

use std::process::Command;

/// Run `az <args>` and return stdout on success. On failure, return a short, sanitized hint
/// (never raw stderr); the common not-signed-in / no-subscription cases get an actionable one.
pub fn run_az(args: &[&str]) -> Result<String, String> {
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

/// Pull the resource group out of an ARM id (`…/resourceGroups/<rg>/…`), case-insensitively
/// (the lookup is lowercased, but the returned segment preserves the id's original case).
pub fn resource_group_from_id(id: Option<&str>) -> Option<String> {
    let id = id?;
    let lower = id.to_lowercase();
    let marker = "/resourcegroups/";
    let start = lower.find(marker)? + marker.len();
    let rest = &id[start..];
    let end = rest.find('/').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_group_from_id_is_case_insensitive_and_preserves_case() {
        let id =
            Some("/subscriptions/x/resourceGroups/rg-Two/providers/Microsoft.KeyVault/vaults/v");
        assert_eq!(resource_group_from_id(id).as_deref(), Some("rg-Two"));
    }

    #[test]
    fn resource_group_from_id_handles_missing_and_trailing() {
        assert_eq!(resource_group_from_id(None), None);
        assert_eq!(resource_group_from_id(Some("/no/group/here")), None);
        // No trailing slash after the group → take to the end.
        assert_eq!(
            resource_group_from_id(Some("/subscriptions/x/resourcegroups/only")).as_deref(),
            Some("only")
        );
    }
}
