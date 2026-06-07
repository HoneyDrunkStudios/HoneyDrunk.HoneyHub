#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessHandle {
    pub run_id: String,
    pub process_id: Option<u32>,
}

impl ProcessHandle {
    pub fn placeholder(run_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            process_id: None,
        }
    }
}
