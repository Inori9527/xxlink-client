use crate::utils::window_manager::WindowManager;
use crate::utils::resolve::ui;
use xxlink_logging::{Type, logging};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::json;
use smartstring::alias::String;

use tauri::{Emitter as _, WebviewWindow};

#[derive(Debug)]
pub enum FrontendEvent {
    RefreshClash,
    RefreshVerge,
    NoticeMessage { status: String, message: String },
    ProfileChanged { current_profile_id: String },
    TimerUpdated { profile_index: String },
    ProfileUpdateStarted { uid: String },
    ProfileUpdateCompleted { uid: String },
}

#[derive(Debug)]
pub struct NotificationSystem {}

static PENDING_EVENTS: Lazy<Mutex<Vec<FrontendEvent>>> = Lazy::new(|| Mutex::new(Vec::new()));

impl NotificationSystem {
    fn emit_to_window(window: &WebviewWindow, event: FrontendEvent) {
        let (event_name, Ok(payload)) = Self::serialize_event(event) else {
            return;
        };

        if let Err(e) = window.emit(event_name, payload) {
            logging!(warn, Type::Frontend, "Event emit failed: {}", e);
        }
    }

    fn serialize_event(event: FrontendEvent) -> (&'static str, Result<serde_json::Value, serde_json::Error>) {
        match event {
            FrontendEvent::RefreshClash => ("verge://refresh-clash-config", Ok(json!("yes"))),
            FrontendEvent::RefreshVerge => ("verge://refresh-verge-config", Ok(json!("yes"))),
            FrontendEvent::NoticeMessage { status, message } => {
                ("verge://notice-message", serde_json::to_value((status, message)))
            }
            FrontendEvent::ProfileChanged { current_profile_id } => ("profile-changed", Ok(json!(current_profile_id))),
            FrontendEvent::TimerUpdated { profile_index } => ("verge://timer-updated", Ok(json!(profile_index))),
            FrontendEvent::ProfileUpdateStarted { uid } => ("profile-update-started", Ok(json!({ "uid": uid }))),
            FrontendEvent::ProfileUpdateCompleted { uid } => ("profile-update-completed", Ok(json!({ "uid": uid }))),
        }
    }

    pub(crate) fn send_event(event: FrontendEvent) {
        if !ui::get_ui_ready().load(std::sync::atomic::Ordering::Acquire) {
            PENDING_EVENTS.lock().push(event);
            return;
        }

        if let Some(window) = WindowManager::get_main_window() {
            Self::emit_to_window(&window, event);
        }
    }

    pub(crate) fn flush_pending_events() {
        if !ui::get_ui_ready().load(std::sync::atomic::Ordering::Acquire) {
            return;
        }

        let Some(window) = WindowManager::get_main_window() else {
            return;
        };

        let pending = {
            let mut queue = PENDING_EVENTS.lock();
            std::mem::take(&mut *queue)
        };

        for event in pending {
            Self::emit_to_window(&window, event);
        }
    }
}
