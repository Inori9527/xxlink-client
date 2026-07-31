use super::runtime_action_controller::{DiagnosticLogSource, DiagnosticLogSummary, summarize_diagnostic_entries};
use crate::config::Config;

/// 获取运行时日志
pub(super) async fn diagnostics_log_summary(max_items: usize) -> DiagnosticLogSummary {
    let runtime = Config::runtime().await.latest_arc();
    let component_count = runtime.chain_logs.len();
    let entries = runtime
        .chain_logs
        .values()
        .flat_map(|entries| {
            entries
                .iter()
                .map(|(level, message)| (level.as_str(), message.as_str()))
        })
        .collect::<Vec<_>>();

    summarize_diagnostic_entries(DiagnosticLogSource::Runtime, component_count, entries, max_items)
}
