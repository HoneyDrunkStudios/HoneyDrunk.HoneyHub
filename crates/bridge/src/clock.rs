//! Dependency-free RFC3339 UTC timestamps.
//!
//! The session contract and wire protocol use RFC3339 strings for `created_at`
//! everywhere. The library itself stays clock-free (callers pass timestamps), but
//! the adapter (and the host) need to stamp events as they happen, so this module
//! offers a small, dependency-free formatter and a `now` helper they can use
//! instead of pulling in a date crate.

use std::time::{SystemTime, UNIX_EPOCH};

/// The current time as an RFC3339 UTC string (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub fn now_rfc3339() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_rfc3339_utc(now.as_secs(), now.subsec_millis())
}

/// Format `seconds` since the Unix epoch (plus `millis`) as RFC3339 UTC. Sorts
/// lexicographically in chronological order, matching the rest of the system.
pub fn format_rfc3339_utc(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`: convert days since the Unix epoch
/// (1970-01-01) into a `(year, month, day)` proleptic-Gregorian date.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_epochs() {
        assert_eq!(format_rfc3339_utc(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_rfc3339_utc(1_000_000_000, 0),
            "2001-09-09T01:46:40.000Z"
        );
        assert_eq!(
            format_rfc3339_utc(1_700_000_000, 123),
            "2023-11-14T22:13:20.123Z"
        );
    }

    #[test]
    fn now_is_rfc3339_shaped() {
        let now = now_rfc3339();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
    }
}
