use crate::core::CoreManager;

pub(super) async fn diagnostics_log_summary(
    max_items: usize,
) -> super::runtime_action_controller::DiagnosticLogSummary {
    let logs = CoreManager::global().get_clash_logs().await.unwrap_or_default();
    let component_count = usize::from(!logs.is_empty());
    let entries = logs
        .iter()
        .map(|entry| parse_clash_log(entry.as_str()))
        .collect::<Vec<_>>();
    super::runtime_action_controller::summarize_diagnostic_entries(
        super::runtime_action_controller::DiagnosticLogSource::Clash,
        component_count,
        entries,
        max_items,
    )
}

fn parse_clash_log(value: &str) -> (&str, &str) {
    if let Some(level_start) = value.find(" level=") {
        let level = &value[level_start + 7..];
        if let Some(message_start) = level.find(" msg=\"") {
            let message = &level[message_start + 6..];
            return (&level[..message_start], message.strip_suffix('"').unwrap_or(message));
        }
    }

    let trimmed = value.trim();
    let Some(first_end) = trimmed.find(char::is_whitespace) else {
        return ("unknown", value);
    };
    let rest = trimmed[first_end..].trim_start();
    let Some(level_end) = rest.find(char::is_whitespace) else {
        return ("unknown", value);
    };
    (rest[..level_end].trim(), rest[level_end..].trim_start())
}

#[cfg(test)]
mod tests {
    use super::parse_clash_log;

    #[test]
    fn parses_structured_and_plain_clash_logs() {
        assert_eq!(
            parse_clash_log(r#"time="2026-07-22T12:00:00Z" level=warning msg="network timeout""#),
            ("warning", "network timeout")
        );
        assert_eq!(
            parse_clash_log("07-22T12:00:00   error   profile sync failed"),
            ("error", "profile sync failed")
        );
    }
}
