//! Local **agent jobs** (control-hub roadmap #7): a read-only snapshot focused on the
//! HoneyDrunk-relevant jobs — the curated dev tools + local runner (the "known jobs"), the
//! processes that belong to them, and the agent-related Windows Scheduled Tasks. It does NOT
//! list every system process or third-party scheduled task; only the agent ones surface.
//!
//! Enumeration is dependency-free: it shells out to the OS process lister and parses the
//! result. On Windows it queries `Get-CimInstance Win32_Process` via PowerShell so each
//! process carries its **command line** (falling back to `tasklist` — image name only — if
//! PowerShell is unavailable); on Unix it uses `ps -o args`. This is **read-only** — it
//! never starts, stops, or signals a process; it only observes. Known-job probes match the
//! image name **and the command line**, so a process running under a generic host (e.g.
//! PowerShell) is recognized by what it is actually running — that is how the **Grid agent
//! runner** is identified by its script path, not just as "powershell".

use crate::adapter::BridgeError;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    /// Resident memory in KiB, when the lister reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_kb: Option<u64>,
    /// The full command line, when the lister reports it (Windows CIM / Unix `ps args`).
    /// Used for known-job matching and shown (truncated) in the process table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// A curated "known job": one or more patterns (matched against image name + command line)
/// and the live match against the current process list. `running` is `instances > 0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownJob {
    pub label: String,
    pub patterns: Vec<String>,
    pub running: bool,
    pub instances: u32,
    pub pids: Vec<u32>,
    /// Summed resident memory (KiB) across matched processes.
    pub memory_kb: u64,
}

/// A Windows Scheduled Task the user owns (non-`\Microsoft\` paths) — a local "job" with a
/// state and a last-run result, so the cockpit can show what's scheduled and what failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub name: String,
    pub path: String,
    /// `Ready` / `Running` / `Disabled` (the task's state).
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
    /// The last run's result code (`0` = success; non-zero = an issue).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_result: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    /// The curated known-job health rows, in definition order.
    pub known: Vec<KnownJob>,
    /// The user's Windows Scheduled Tasks (non-`\Microsoft\`); empty off Windows.
    pub scheduled: Vec<ScheduledTask>,
    /// The agent/dev processes (those matching a known job), sorted by memory desc.
    pub processes: Vec<ProcessInfo>,
    /// Reserved (the list is narrowed to agent jobs, so always `false`).
    pub truncated: bool,
}

/// A job probe: a human label and the substrings that identify it, matched against each
/// process's image name **and** command line. Owned (not `&'static`) so the set can be
/// extended at runtime with **user-defined** probes coming from the cockpit. So a path-based
/// pattern like `grid-agent-runner` recognizes the runner even though its image name is
/// `powershell`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProbe {
    pub label: String,
    pub patterns: Vec<String>,
}

impl JobProbe {
    /// Build a probe from string-likes (handy for both the static defaults and tests).
    fn new(label: impl Into<String>, patterns: &[&str]) -> Self {
        JobProbe {
            label: label.into(),
            patterns: patterns.iter().map(|p| (*p).to_string()).collect(),
        }
    }

    /// Drop empties and lowercase patterns; a probe with no usable pattern is `None` so a
    /// blank user entry never matches everything.
    fn sanitized(&self) -> Option<JobProbe> {
        let label = self.label.trim();
        let patterns: Vec<String> = self
            .patterns
            .iter()
            .map(|p| p.trim().to_lowercase())
            .filter(|p| !p.is_empty())
            .collect();
        if label.is_empty() || patterns.is_empty() {
            return None;
        }
        Some(JobProbe {
            label: label.to_string(),
            patterns,
        })
    }
}

/// The curated probes: the dev tools + local runner HoneyHub recognizes out of the box.
/// Users can add their own via the cockpit (merged in by [`merge_probes`]).
pub fn default_job_probes() -> Vec<JobProbe> {
    vec![
        JobProbe::new("Claude Code", &["claude"]),
        JobProbe::new("Codex", &["codex"]),
        JobProbe::new("HoneyHub desktop", &["honeyhub-desktop"]),
        JobProbe::new("HoneyHub bridge host", &["honeyhub-bridge-host"]),
        // Command-line match: the runner is a PowerShell process running this script tree.
        JobProbe::new("Grid agent runner", &["grid-agent-runner"]),
        JobProbe::new("Node", &["node"]),
        JobProbe::new("Rust build (cargo/rustc)", &["cargo", "rustc"]),
        JobProbe::new("PowerShell", &["pwsh.exe", "powershell.exe"]),
        JobProbe::new("Git", &["git.exe", "/git", "\\git"]),
    ]
}

/// Merge the curated defaults with the user's extra probes: defaults first (stable order),
/// then each sanitized user probe whose label isn't already a default (case-insensitive),
/// so a user can append jobs without duplicating or clobbering the built-ins.
pub fn merge_probes(extra: &[JobProbe]) -> Vec<JobProbe> {
    let mut probes = default_job_probes();
    let mut seen: std::collections::HashSet<String> =
        probes.iter().map(|p| p.label.to_lowercase()).collect();
    for probe in extra {
        if let Some(clean) = probe.sanitized() {
            if seen.insert(clean.label.to_lowercase()) {
                probes.push(clean);
            }
        }
    }
    probes
}

/// Keywords (lowercased) that mark a Scheduled Task as an "agent" job worth surfacing — so
/// the Jobs view shows the HoneyDrunk/agent runner tasks, not every third-party Windows task.
const AGENT_TASK_KEYWORDS: &[&str] = &[
    "grid-agent-runner",
    "honeydrunk",
    "honeyhub",
    "claude",
    "codex",
];

/// The agent-task keywords merged with the user's extras (lowercased, blanks dropped).
fn merge_task_keywords(extra: &[String]) -> Vec<String> {
    let mut keywords: Vec<String> = AGENT_TASK_KEYWORDS.iter().map(|k| k.to_string()).collect();
    for keyword in extra {
        let clean = keyword.trim().to_lowercase();
        if !clean.is_empty() && !keywords.contains(&clean) {
            keywords.push(clean);
        }
    }
    keywords
}

fn is_agent_task(task: &ScheduledTask, keywords: &[String]) -> bool {
    let haystack = format!("{} {}", task.name, task.path).to_lowercase();
    keywords.iter().any(|keyword| haystack.contains(keyword))
}

/// Build a snapshot focused on **agent jobs**: enumerate processes, match the curated probes
/// (plus the user's `extra_probes`), and keep only the processes + scheduled tasks that belong
/// to a known agent/dev job — not every Windows process or third-party scheduled task. The
/// user's `extra_task_keywords` widen which Scheduled Tasks count as "agent" tasks.
pub fn snapshot(
    extra_probes: &[JobProbe],
    extra_task_keywords: &[String],
) -> Result<JobSnapshot, BridgeError> {
    let mut processes = list_processes()?;
    // Sort by memory desc (most significant first), then name for stability.
    processes.sort_by(|a, b| {
        b.memory_kb
            .unwrap_or(0)
            .cmp(&a.memory_kb.unwrap_or(0))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let known = match_known(&processes, &merge_probes(extra_probes));
    // Keep only processes that matched a known agent/dev job (drop the system noise).
    let matched: std::collections::HashSet<u32> = known
        .iter()
        .flat_map(|job| job.pids.iter().copied())
        .collect();
    processes.retain(|process| matched.contains(&process.pid));
    // Scheduled tasks: only the agent-relevant ones (defaults + the user's keywords).
    let keywords = merge_task_keywords(extra_task_keywords);
    let scheduled = list_scheduled_tasks()
        .into_iter()
        .filter(|task| is_agent_task(task, &keywords))
        .collect();
    Ok(JobSnapshot {
        known,
        scheduled,
        processes,
        // The list is already narrowed to agent jobs, so it is never capped/truncated.
        truncated: false,
    })
}

/// Match the probes against a process list (pure, so it is unit-testable). Patterns are
/// compared lowercased; the defaults are already lowercase and user probes are lowercased by
/// [`JobProbe::sanitized`], but we lowercase here too so a raw `match_known` call is robust.
pub fn match_known(processes: &[ProcessInfo], probes: &[JobProbe]) -> Vec<KnownJob> {
    probes
        .iter()
        .map(|probe| {
            let patterns: Vec<String> = probe.patterns.iter().map(|p| p.to_lowercase()).collect();
            let mut pids = Vec::new();
            let mut memory_kb = 0u64;
            for process in processes {
                // Match the image name AND the command line, so a path-based pattern
                // recognizes a process running under a generic host (e.g. PowerShell).
                let mut haystack = process.name.to_lowercase();
                if let Some(command) = &process.command {
                    haystack.push(' ');
                    haystack.push_str(&command.to_lowercase());
                }
                if patterns.iter().any(|pattern| haystack.contains(pattern)) {
                    pids.push(process.pid);
                    memory_kb += process.memory_kb.unwrap_or(0);
                }
            }
            KnownJob {
                label: probe.label.clone(),
                patterns: probe.patterns.clone(),
                running: !pids.is_empty(),
                instances: pids.len() as u32,
                pids,
                memory_kb,
            }
        })
        .collect()
}

/// Enumerate running processes via the OS lister. On Windows, prefer the CIM query (carries
/// the command line), falling back to `tasklist` (image name only) when PowerShell is
/// unavailable. On Unix, use `ps -o args` (carries the command line). Best-effort: a failed
/// lister yields an error the host surfaces; garbled lines are skipped, not fatal.
pub fn list_processes() -> Result<Vec<ProcessInfo>, BridgeError> {
    if cfg!(windows) {
        if let Some(processes) = cim_processes() {
            return Ok(processes);
        }
        let output = Command::new("tasklist")
            .args(["/fo", "csv", "/nh"])
            .output()
            .map_err(|error| BridgeError::new("jobs_list_failed", error.to_string()))?;
        if !output.status.success() {
            return Err(BridgeError::new(
                "jobs_list_failed",
                "the process lister exited with an error",
            ));
        }
        Ok(parse_tasklist_csv(&String::from_utf8_lossy(&output.stdout)))
    } else {
        let output = Command::new("ps")
            .args(["-axww", "-o", "pid=,rss=,comm=,args="])
            .output()
            .map_err(|error| BridgeError::new("jobs_list_failed", error.to_string()))?;
        if !output.status.success() {
            return Err(BridgeError::new(
                "jobs_list_failed",
                "the process lister exited with an error",
            ));
        }
        Ok(parse_ps_args(&String::from_utf8_lossy(&output.stdout)))
    }
}

/// Query `Win32_Process` via PowerShell for processes WITH their command lines, as JSON.
/// `None` when PowerShell is missing/errors or yields nothing (caller falls back).
#[cfg(windows)]
fn cim_processes() -> Option<Vec<ProcessInfo>> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let processes = parse_cim_json(&String::from_utf8_lossy(&output.stdout));
    (!processes.is_empty()).then_some(processes)
}

#[cfg(not(windows))]
fn cim_processes() -> Option<Vec<ProcessInfo>> {
    None
}

/// Parse the `Get-CimInstance Win32_Process | ConvertTo-Json` output (an array, or a single
/// object when only one process). `WorkingSetSize` is bytes → KiB; `CommandLine` may be null.
pub fn parse_cim_json(text: &str) -> Vec<ProcessInfo> {
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
            let pid = u32::try_from(item.get("ProcessId")?.as_u64()?).ok()?;
            let name = item.get("Name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return None;
            }
            let memory_kb = item
                .get("WorkingSetSize")
                .and_then(|v| v.as_u64())
                .map(|bytes| bytes / 1024);
            let command = item
                .get("CommandLine")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some(ProcessInfo {
                pid,
                name: name.to_string(),
                memory_kb,
                command,
            })
        })
        .collect()
}

/// Parse `tasklist /fo csv /nh` rows: `"Image","PID","Session","Session#","Mem K"`. No
/// command line is available from tasklist, so `command` is `None`.
pub fn parse_tasklist_csv(text: &str) -> Vec<ProcessInfo> {
    text.lines()
        .filter_map(|line| {
            let fields = split_csv(line);
            if fields.len() < 5 {
                return None;
            }
            let pid = fields[1].trim().parse::<u32>().ok()?;
            let name = fields[0].trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(ProcessInfo {
                pid,
                name,
                memory_kb: parse_mem_kb(&fields[4]),
                command: None,
            })
        })
        .collect()
}

/// Parse `ps -axww -o pid=,rss=,comm=,args=` rows: `  1234 45678 node node --flag a b` (rss
/// is KiB; `comm` is one token; `args` is the full command line, kept intact).
pub fn parse_ps_args(text: &str) -> Vec<ProcessInfo> {
    text.lines()
        .filter_map(|line| {
            let (pid_str, rest) = next_token(line);
            let (rss_str, rest) = next_token(rest);
            let (comm, args) = next_token(rest);
            let pid = pid_str.parse::<u32>().ok()?;
            if comm.is_empty() {
                return None;
            }
            let command = {
                let trimmed = args.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            };
            Some(ProcessInfo {
                pid,
                name: comm.to_string(),
                memory_kb: rss_str.parse::<u64>().ok(),
                command,
            })
        })
        .collect()
}

/// Split off the first whitespace-delimited token, returning it and the untouched remainder
/// (so a trailing command line keeps its internal spaces). Handles column padding by
/// trimming leading whitespace first.
fn next_token(s: &str) -> (&str, &str) {
    let s = s.trim_start();
    match s.find(char::is_whitespace) {
        Some(index) => (&s[..index], &s[index..]),
        None => (s, ""),
    }
}

/// The PowerShell that lists the user's (non-`\Microsoft\`) Scheduled Tasks joined with
/// their last-run info, as JSON. Written for Windows PowerShell 5.1 (the `$(if …)`
/// subexpression form); times are emitted ISO-8601, null when never run / not scheduled.
#[cfg(windows)]
const SCHEDULED_TASKS_PS: &str = "Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ TaskName=$_.TaskName; TaskPath=$_.TaskPath; State=$_.State.ToString(); LastRunTime=$(if($i.LastRunTime){$i.LastRunTime.ToString('o')}else{$null}); LastTaskResult=$i.LastTaskResult; NextRunTime=$(if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{$null}) } } | ConvertTo-Json -Compress";

/// Enumerate the user's Windows Scheduled Tasks (non-`\Microsoft\`). Best-effort: any
/// failure (no PowerShell, no scheduler) yields an empty list — never fails the snapshot.
/// Always empty off Windows (Scheduled Tasks is a Windows concept).
#[cfg(windows)]
fn list_scheduled_tasks() -> Vec<ScheduledTask> {
    let Ok(output) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCHEDULED_TASKS_PS,
        ])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_scheduled_tasks_json(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(windows))]
fn list_scheduled_tasks() -> Vec<ScheduledTask> {
    Vec::new()
}

/// Parse the scheduled-tasks JSON (an array, or a single object when only one task).
pub fn parse_scheduled_tasks_json(text: &str) -> Vec<ScheduledTask> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let items: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(array) => array.iter().collect(),
        serde_json::Value::Object(_) => vec![&value],
        _ => return Vec::new(),
    };
    let string_field = |item: &serde_json::Value, key: &str| {
        item.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    items
        .into_iter()
        .filter_map(|item| {
            let name = string_field(item, "TaskName")?;
            Some(ScheduledTask {
                name,
                path: string_field(item, "TaskPath").unwrap_or_else(|| "\\".to_string()),
                state: string_field(item, "State").unwrap_or_else(|| "Unknown".to_string()),
                last_run: string_field(item, "LastRunTime"),
                last_result: item.get("LastTaskResult").and_then(|v| v.as_i64()),
                next_run: string_field(item, "NextRunTime"),
            })
        })
        .collect()
}

/// Parse a `tasklist` memory cell like `"45,678 K"` into KiB.
fn parse_mem_kb(cell: &str) -> Option<u64> {
    let digits: String = cell.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

/// Minimal CSV splitter for `tasklist` output: comma-separated, each field double-quoted,
/// no embedded quotes in practice. Strips the surrounding quotes.
fn split_csv(line: &str) -> Vec<String> {
    line.split("\",\"")
        .map(|field| field.trim_matches('"').to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tasklist_csv_rows() {
        let text = "\"honeyhub-desktop.exe\",\"12345\",\"Console\",\"1\",\"45,678 K\"\n\
                    \"node.exe\",\"222\",\"Console\",\"1\",\"9,000 K\"\n";
        let procs = parse_tasklist_csv(text);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 12345);
        assert_eq!(procs[0].name, "honeyhub-desktop.exe");
        assert_eq!(procs[0].memory_kb, Some(45678));
        assert_eq!(procs[1].memory_kb, Some(9000));
    }

    #[test]
    fn skips_garbled_tasklist_rows() {
        let text = "not,a,valid,row\n\"\",\"x\",\"\",\"\",\"\"\n";
        assert!(parse_tasklist_csv(text).is_empty());
    }

    #[test]
    fn parses_ps_args_rows_keeping_the_command_line() {
        // Padded numeric columns + a command line with internal spaces.
        let text =
            "  1234  45678 node node --inspect /app/server.js\n   55 1024 cargo cargo build\n";
        let procs = parse_ps_args(text);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "node");
        assert_eq!(procs[0].memory_kb, Some(45678));
        assert_eq!(
            procs[0].command.as_deref(),
            Some("node --inspect /app/server.js")
        );
        assert_eq!(procs[1].command.as_deref(), Some("cargo build"));
    }

    #[test]
    fn parses_cim_json_array_and_single_object() {
        let array = r#"[
            {"ProcessId":10,"Name":"powershell.exe","WorkingSetSize":104857600,"CommandLine":"powershell -File C:\\HoneyDrunk\\grid-agent-runner\\run.ps1"},
            {"ProcessId":11,"Name":"node.exe","WorkingSetSize":2048,"CommandLine":null}
        ]"#;
        let procs = parse_cim_json(array);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 10);
        assert_eq!(procs[0].memory_kb, Some(102400)); // 100 MiB in KiB
        assert!(procs[0]
            .command
            .as_deref()
            .unwrap()
            .contains("grid-agent-runner"));
        // Null command line → None.
        assert_eq!(procs[1].command, None);

        // A single process serializes as an object, not an array.
        let single = r#"{"ProcessId":7,"Name":"codex.exe","WorkingSetSize":1024,"CommandLine":"codex exec"}"#;
        let one = parse_cim_json(single);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].name, "codex.exe");
    }

    #[test]
    fn parses_scheduled_tasks_json() {
        let json = r#"[
            {"TaskName":"grid-agent-runner","TaskPath":"\\","State":"Ready","LastRunTime":"2026-06-14T10:00:00.0000000-04:00","LastTaskResult":0,"NextRunTime":"2026-06-14T16:00:00.0000000-04:00"},
            {"TaskName":"broken-job","TaskPath":"\\HoneyDrunk\\","State":"Ready","LastRunTime":"2026-06-13T00:00:00.0000000-04:00","LastTaskResult":1,"NextRunTime":null}
        ]"#;
        let tasks = parse_scheduled_tasks_json(json);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].name, "grid-agent-runner");
        assert_eq!(tasks[0].state, "Ready");
        assert_eq!(tasks[0].last_result, Some(0));
        assert!(tasks[0].next_run.is_some());
        // A non-zero last result = an issue; null next-run → None.
        assert_eq!(tasks[1].last_result, Some(1));
        assert_eq!(tasks[1].next_run, None);

        // A single task serializes as an object, not an array.
        let single = r#"{"TaskName":"solo","TaskPath":"\\","State":"Disabled","LastTaskResult":0}"#;
        let one = parse_scheduled_tasks_json(single);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].state, "Disabled");
        assert_eq!(one[0].last_run, None);
    }

    #[test]
    fn is_agent_task_keeps_agent_tasks_and_drops_third_party() {
        let agent = ScheduledTask {
            name: "grid-agent-runner".to_string(),
            path: "\\".to_string(),
            state: "Ready".to_string(),
            last_run: None,
            last_result: Some(0),
            next_run: None,
        };
        let third_party = ScheduledTask {
            name: "Adobe Acrobat Update".to_string(),
            path: "\\".to_string(),
            state: "Ready".to_string(),
            last_run: None,
            last_result: Some(0),
            next_run: None,
        };
        let keywords = merge_task_keywords(&[]);
        assert!(is_agent_task(&agent, &keywords));
        assert!(!is_agent_task(&third_party, &keywords));

        // A user keyword widens what counts as an agent task.
        let widened = merge_task_keywords(&["acrobat".to_string()]);
        assert!(is_agent_task(&third_party, &widened));
    }

    #[test]
    fn matches_known_jobs_on_image_name_and_command_line() {
        let processes = vec![
            ProcessInfo {
                pid: 1,
                name: "node.exe".to_string(),
                memory_kb: Some(100),
                command: None,
            },
            ProcessInfo {
                pid: 2,
                name: "Node.exe".to_string(),
                memory_kb: Some(50),
                command: None,
            },
            // A PowerShell host running the Grid runner — recognized by its command line.
            ProcessInfo {
                pid: 3,
                name: "powershell.exe".to_string(),
                memory_kb: Some(80),
                command: Some(
                    "powershell -File C:\\HoneyDrunk\\grid-agent-runner\\run.ps1".to_string(),
                ),
            },
        ];
        let probes = vec![
            JobProbe::new("Node", &["node"]),
            JobProbe::new("Grid agent runner", &["grid-agent-runner"]),
            JobProbe::new("Codex", &["codex"]),
        ];
        let known = match_known(&processes, &probes);
        let node = &known[0];
        assert_eq!(node.instances, 2);
        assert_eq!(node.memory_kb, 150);
        // The runner matched via command line despite its image name being powershell.exe.
        let runner = &known[1];
        assert!(runner.running);
        assert_eq!(runner.pids, vec![3]);
        let codex = &known[2];
        assert!(!codex.running);
    }

    #[test]
    fn merge_probes_appends_user_jobs_and_skips_dupes_and_blanks() {
        let defaults = default_job_probes().len();
        let merged = merge_probes(&[
            // A genuinely new job is appended.
            JobProbe::new("My worker", &["my-worker"]),
            // A label that collides with a default (case-insensitively) is dropped.
            JobProbe::new("codex", &["something-else"]),
            // A blank/empty probe never matches everything — it's dropped.
            JobProbe::new("  ", &["x"]),
            JobProbe {
                label: "Empty patterns".to_string(),
                patterns: vec!["   ".to_string()],
            },
        ]);
        assert_eq!(merged.len(), defaults + 1);
        let added = merged.last().unwrap();
        assert_eq!(added.label, "My worker");
        assert_eq!(added.patterns, vec!["my-worker".to_string()]);
    }

    #[test]
    fn merge_task_keywords_adds_user_keywords_without_duplicates() {
        let merged = merge_task_keywords(&["MyAgent".to_string(), "claude".to_string()]);
        // "claude" already exists; "myagent" (lowercased) is appended once.
        assert_eq!(merged.iter().filter(|k| k.as_str() == "claude").count(), 1);
        assert!(merged.contains(&"myagent".to_string()));
    }
}
