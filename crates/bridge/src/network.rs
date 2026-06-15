//! Reachable network addresses for **mobile pairing** ("Connect a phone"). A read-only
//! enumeration of this host's non-loopback IPv4 addresses, classified so the cockpit can
//! show which address a phone should use — one on the same LAN (Wi-Fi), or a **Tailscale
//! tailnet** address (the `100.64.0.0/10` CGNAT range, per ADR-0091's "bind the tailnet IP,
//! not 0.0.0.0" guidance). Dependency-free: it shells out to the OS (Windows
//! `Get-NetIPAddress` as JSON; Unix `ip -o -4 addr`) and parses the result. This NEVER
//! changes any network state; it only observes — and surfacing an address does not, by
//! itself, make the host reachable on it (the host must also be bound to a reachable
//! interface; the cockpit explains that honestly).

use serde::{Deserialize, Serialize};
use std::process::Command;

/// How a reachable address is reached, so the cockpit can label/prioritize it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetAddressKind {
    /// A Tailscale tailnet address (`100.64.0.0/10`) — reachable from any tailnet device.
    Tailnet,
    /// A private LAN address (`10/8`, `172.16/12`, `192.168/16`) — same Wi-Fi / subnet.
    Lan,
    /// Any other (e.g. a public address) — shown last; rare on a dev box.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetAddress {
    pub ip: String,
    pub kind: NetAddressKind,
    /// The interface this address belongs to, when the lister reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    /// The host's reachable IPv4 addresses, tailnet first, then LAN, then other.
    pub addresses: Vec<NetAddress>,
}

/// Enumerate this host's reachable (non-loopback) IPv4 addresses, classified and ordered
/// tailnet → LAN → other. Best-effort: a missing lister yields an empty list, never an error
/// (the cockpit treats "no reachable address" as "loopback only").
pub fn reachable_addresses() -> NetworkInfo {
    let mut addresses: Vec<NetAddress> = raw_addresses()
        .into_iter()
        .filter_map(|(ip, interface)| {
            classify(&ip).map(|kind| NetAddress {
                ip,
                kind,
                interface,
            })
        })
        .collect();
    addresses.sort_by_key(|address| match address.kind {
        NetAddressKind::Tailnet => 0,
        NetAddressKind::Lan => 1,
        NetAddressKind::Other => 2,
    });
    NetworkInfo { addresses }
}

/// Classify a dotted-quad IPv4 string, dropping loopback / link-local / unspecified — only
/// addresses a phone could actually reach are kept. `None` = not a usable reachable address.
pub fn classify(ip: &str) -> Option<NetAddressKind> {
    let octets = parse_ipv4(ip)?;
    let [a, b, ..] = octets;
    match (a, b) {
        // Loopback (127/8), unspecified (0.x), link-local (169.254/16) → not reachable.
        (127, _) | (0, _) | (169, 254) => None,
        // Tailscale tailnet: 100.64.0.0/10 → 100.64.x – 100.127.x.
        (100, 64..=127) => Some(NetAddressKind::Tailnet),
        // Private LAN ranges.
        (10, _) => Some(NetAddressKind::Lan),
        (172, 16..=31) => Some(NetAddressKind::Lan),
        (192, 168) => Some(NetAddressKind::Lan),
        _ => Some(NetAddressKind::Other),
    }
}

/// Parse a dotted-quad IPv4 string into four octets (rejecting anything malformed).
fn parse_ipv4(ip: &str) -> Option<[u8; 4]> {
    let mut octets = [0u8; 4];
    let mut parts = ip.trim().split('.');
    for octet in &mut octets {
        *octet = parts.next()?.parse::<u8>().ok()?;
    }
    if parts.next().is_some() {
        return None; // more than four parts
    }
    Some(octets)
}

/// Enumerate `(ip, interface)` pairs from the OS, without classification.
fn raw_addresses() -> Vec<(String, Option<String>)> {
    if cfg!(windows) {
        windows_addresses().unwrap_or_default()
    } else {
        unix_addresses().unwrap_or_default()
    }
}

/// Windows: `Get-NetIPAddress -AddressFamily IPv4` as JSON (carries InterfaceAlias).
#[cfg(windows)]
fn windows_addresses() -> Option<Vec<(String, Option<String>)>> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress,InterfaceAlias | ConvertTo-Json -Compress",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_get_netipaddress_json(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(not(windows))]
fn windows_addresses() -> Option<Vec<(String, Option<String>)>> {
    None
}

/// Unix: `ip -o -4 addr show` → lines like `2: eth0    inet 192.168.1.5/24 ...`.
#[cfg(not(windows))]
fn unix_addresses() -> Option<Vec<(String, Option<String>)>> {
    let output = Command::new("ip")
        .args(["-o", "-4", "addr", "show"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_ip_addr_show(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
fn unix_addresses() -> Option<Vec<(String, Option<String>)>> {
    None
}

/// Parse `Get-NetIPAddress | ConvertTo-Json` (an array, or a single object when only one).
pub fn parse_get_netipaddress_json(text: &str) -> Vec<(String, Option<String>)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let items: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(array) => array.iter().collect(),
        serde_json::Value::Object(_) => vec![&value],
        _ => return Vec::new(),
    };
    items
        .into_iter()
        .filter_map(|item| {
            let ip = item.get("IPAddress")?.as_str()?.trim().to_string();
            if ip.is_empty() {
                return None;
            }
            let interface = item
                .get("InterfaceAlias")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some((ip, interface))
        })
        .collect()
}

/// Parse `ip -o -4 addr show` output: whitespace columns, `inet <ip>/<prefix>` after the
/// interface name (the second column), e.g. `2: eth0    inet 192.168.1.5/24 brd ...`.
pub fn parse_ip_addr_show(text: &str) -> Vec<(String, Option<String>)> {
    text.lines()
        .filter_map(|line| {
            let mut tokens = line.split_whitespace();
            let _index = tokens.next()?; // "2:"
            let interface = tokens.next()?.to_string();
            // The `inet` marker is followed by `<ip>/<prefix>`; take the token after it.
            let ip_cidr = tokens.by_ref().skip_while(|token| *token != "inet").nth(1);
            let ip = ip_cidr?.split('/').next()?.to_string();
            if ip.is_empty() {
                return None;
            }
            Some((ip, Some(interface)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_addresses_by_reachability() {
        assert_eq!(classify("127.0.0.1"), None);
        assert_eq!(classify("0.0.0.0"), None);
        assert_eq!(classify("169.254.1.2"), None);
        assert_eq!(classify("100.101.102.103"), Some(NetAddressKind::Tailnet));
        assert_eq!(classify("100.63.0.1"), Some(NetAddressKind::Other)); // just below tailnet
        assert_eq!(classify("192.168.1.5"), Some(NetAddressKind::Lan));
        assert_eq!(classify("10.1.2.3"), Some(NetAddressKind::Lan));
        assert_eq!(classify("172.16.0.9"), Some(NetAddressKind::Lan));
        assert_eq!(classify("172.32.0.9"), Some(NetAddressKind::Other)); // outside 172.16/12
        assert_eq!(classify("8.8.8.8"), Some(NetAddressKind::Other));
        assert_eq!(classify("not-an-ip"), None);
        assert_eq!(classify("1.2.3.4.5"), None);
    }

    #[test]
    fn parses_get_netipaddress_array_and_single_object() {
        let array = r#"[
            {"IPAddress":"192.168.1.20","InterfaceAlias":"Wi-Fi"},
            {"IPAddress":"100.110.120.130","InterfaceAlias":"Tailscale"},
            {"IPAddress":"127.0.0.1","InterfaceAlias":"Loopback"}
        ]"#;
        let raw = parse_get_netipaddress_json(array);
        assert_eq!(raw.len(), 3);
        assert_eq!(
            raw[0],
            ("192.168.1.20".to_string(), Some("Wi-Fi".to_string()))
        );

        let single = r#"{"IPAddress":"10.0.0.5","InterfaceAlias":"Ethernet"}"#;
        let one = parse_get_netipaddress_json(single);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].0, "10.0.0.5");
    }

    #[test]
    fn parses_ip_addr_show_lines() {
        let text = "1: lo    inet 127.0.0.1/8 scope host lo\n\
                    2: eth0    inet 192.168.1.5/24 brd 192.168.1.255 scope global eth0\n\
                    3: tailscale0    inet 100.110.0.1/32 scope global tailscale0\n";
        let raw = parse_ip_addr_show(text);
        assert_eq!(raw.len(), 3);
        assert_eq!(
            raw[1],
            ("192.168.1.5".to_string(), Some("eth0".to_string()))
        );
        assert_eq!(raw[2].0, "100.110.0.1");
    }

    #[test]
    fn reachable_addresses_orders_tailnet_then_lan_then_other() {
        // Drive the ordering through the public sort by classifying a known mix.
        let mut addresses: Vec<NetAddress> = ["8.8.8.8", "192.168.1.5", "100.100.0.1"]
            .into_iter()
            .filter_map(|ip| {
                classify(ip).map(|kind| NetAddress {
                    ip: ip.to_string(),
                    kind,
                    interface: None,
                })
            })
            .collect();
        addresses.sort_by_key(|address| match address.kind {
            NetAddressKind::Tailnet => 0,
            NetAddressKind::Lan => 1,
            NetAddressKind::Other => 2,
        });
        assert_eq!(addresses[0].kind, NetAddressKind::Tailnet);
        assert_eq!(addresses[1].kind, NetAddressKind::Lan);
        assert_eq!(addresses[2].kind, NetAddressKind::Other);
    }
}
