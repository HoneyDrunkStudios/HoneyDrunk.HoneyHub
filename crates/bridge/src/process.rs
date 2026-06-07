#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessHandle {
    pub run_id: String,
    pub process_id: Option<u32>,
    pub command: Vec<String>,
    pub started_at: Option<String>,
    pub graceful_stop_timeout_ms: u64,
}

impl ProcessHandle {
    pub fn placeholder(run_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            process_id: None,
            command: Vec::new(),
            started_at: None,
            graceful_stop_timeout_ms: 5_000,
        }
    }

    pub fn launched(
        run_id: impl Into<String>,
        process_id: Option<u32>,
        command: Vec<String>,
        started_at: impl Into<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            process_id,
            command: redact_command_line(&command),
            started_at: Some(started_at.into()),
            graceful_stop_timeout_ms: 5_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessExitStatus {
    pub run_id: String,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub success: bool,
    pub exited_at: String,
}

impl ProcessExitStatus {
    pub fn summary(&self) -> String {
        match (&self.code, &self.signal) {
            (Some(code), _) => format!("process exited with code {code}"),
            (_, Some(signal)) => format!("process exited from signal {signal}"),
            _ => "process exited without status".to_string(),
        }
    }
}

pub fn redact_command_line(command: &[String]) -> Vec<String> {
    let mut redacted = Vec::with_capacity(command.len());
    let mut redact_next = false;

    for part in command {
        if redact_next {
            redacted.push("[REDACTED]".to_string());
            redact_next = false;
            continue;
        }

        let lower = part.to_ascii_lowercase();
        if let Some((name, _value)) = part.split_once('=') {
            if is_secret_flag(&name.to_ascii_lowercase()) {
                redacted.push(format!("{name}=[REDACTED]"));
            } else {
                redacted.push(part.clone());
            }
        } else if is_secret_flag(&lower) {
            redacted.push(part.clone());
            redact_next = true;
        } else {
            redacted.push(part.clone());
        }
    }

    redacted
}

fn is_secret_flag(value: &str) -> bool {
    let normalized = value.replace('_', "-");
    matches!(
        normalized.as_str(),
        "--token" | "--access-token" | "--api-key" | "--apikey" | "--secret" | "--password" | "-p"
    ) || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("api-key")
        || normalized.contains("apikey")
        || normalized.contains("password")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secret_command_arguments_before_persistence() {
        let redacted = redact_command_line(&[
            "claude".to_string(),
            "--api-key".to_string(),
            "super-secret".to_string(),
            "--model=sonnet".to_string(),
            "--token=abc123".to_string(),
            "OPENAI_API_KEY=sk-test".to_string(),
            "ANTHROPIC_API_KEY=sk-ant-test".to_string(),
            "--access_token".to_string(),
            "token-value".to_string(),
            "--api_key=flag-secret".to_string(),
        ]);

        assert_eq!(
            redacted,
            vec![
                "claude".to_string(),
                "--api-key".to_string(),
                "[REDACTED]".to_string(),
                "--model=sonnet".to_string(),
                "--token=[REDACTED]".to_string(),
                "OPENAI_API_KEY=[REDACTED]".to_string(),
                "ANTHROPIC_API_KEY=[REDACTED]".to_string(),
                "--access_token".to_string(),
                "[REDACTED]".to_string(),
                "--api_key=[REDACTED]".to_string()
            ]
        );
    }
}
