use crate::{core::handle, utils::resolve::window::build_new_window};
use once_cell::sync::Lazy;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Manager as _, WebviewWindow, Wry};
use xxlink_limiter::Limiter;
use xxlink_logging::{Type, logging};

/// 窗口操作结果
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowOperationResult {
    /// 窗口已显示并获得焦点
    Shown,
    /// 窗口已隐藏
    Hidden,
    /// Window minimized as a close-request fallback.
    Minimized,
    /// 创建了新窗口
    Created,
    /// 摧毁了窗口
    Destroyed,
    /// 操作失败
    Failed,
    /// 无需操作
    NoAction,
}

/// 窗口状态
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowState {
    /// 窗口可见且有焦点
    VisibleFocused,
    /// 窗口可见但无焦点
    VisibleUnfocused,
    /// 窗口最小化
    Minimized,
    /// 窗口隐藏
    Hidden,
    /// 窗口不存在
    NotExist,
}

// 窗口操作防抖机制
const WINDOW_OPERATION_DEBOUNCE_MS: u64 = 625;
static WINDOW_OPERATION_LIMITER: Lazy<Limiter> = Lazy::new(|| {
    Limiter::new(
        Duration::from_millis(WINDOW_OPERATION_DEBOUNCE_MS),
        xxlink_limiter::SystemClock,
    )
});

const CLOSE_LIFECYCLE_LOG_INTERVAL_MS: u64 = 2000;
static CLOSE_LIFECYCLE_LOG_LIMITER: Lazy<Limiter> = Lazy::new(|| {
    Limiter::new(
        Duration::from_millis(CLOSE_LIFECYCLE_LOG_INTERVAL_MS),
        xxlink_limiter::SystemClock,
    )
});
static CLOSE_WARNING_LOG_LIMITER: Lazy<Limiter> = Lazy::new(|| {
    Limiter::new(
        Duration::from_millis(CLOSE_LIFECYCLE_LOG_INTERVAL_MS),
        xxlink_limiter::SystemClock,
    )
});
static CLOSE_REQUEST_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct CloseRequestGuard;

impl CloseRequestGuard {
    fn try_acquire() -> Option<Self> {
        CLOSE_REQUEST_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for CloseRequestGuard {
    fn drop(&mut self) {
        CLOSE_REQUEST_IN_FLIGHT.store(false, Ordering::Release);
    }
}

fn should_handle_window_operation() -> bool {
    let allow = WINDOW_OPERATION_LIMITER.check();
    if !allow {
        logging!(debug, Type::Window, "window operation rate limited");
    }
    allow
}

fn should_log_close_lifecycle() -> bool {
    CLOSE_LIFECYCLE_LOG_LIMITER.check()
}

fn should_log_close_warning() -> bool {
    CLOSE_WARNING_LOG_LIMITER.check()
}

/// Unified window manager.
pub struct WindowManager;

impl WindowManager {
    pub fn get_main_window_with_state() -> (Option<WebviewWindow<Wry>>, WindowState) {
        let Some(window) = Self::get_main_window() else {
            return (None, WindowState::NotExist);
        };

        let is_minimized = window.is_minimized().unwrap_or(false);
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);

        let state = if is_minimized {
            WindowState::Minimized
        } else if !is_visible {
            WindowState::Hidden
        } else if is_focused {
            WindowState::VisibleFocused
        } else {
            WindowState::VisibleUnfocused
        };

        (Some(window), state)
    }

    pub fn get_main_window_state() -> WindowState {
        match Self::get_main_window() {
            Some(window) => {
                let is_minimized = window.is_minimized().unwrap_or(false);
                let is_visible = window.is_visible().unwrap_or(false);
                let is_focused = window.is_focused().unwrap_or(false);

                if is_minimized {
                    return WindowState::Minimized;
                }

                if !is_visible {
                    return WindowState::Hidden;
                }

                if is_focused {
                    WindowState::VisibleFocused
                } else {
                    WindowState::VisibleUnfocused
                }
            }
            None => WindowState::NotExist,
        }
    }

    /// 获取主窗口实例
    pub fn get_main_window() -> Option<WebviewWindow<Wry>> {
        let app_handle = handle::Handle::app_handle();
        app_handle.get_webview_window("main")
    }

    fn is_main_tray_available() -> bool {
        let app_handle = handle::Handle::app_handle();
        app_handle.tray_by_id("main").is_some()
    }

    pub fn handle_close_requested() -> WindowOperationResult {
        let Some(_guard) = CloseRequestGuard::try_acquire() else {
            if should_log_close_lifecycle() {
                logging!(
                    debug,
                    Type::Window,
                    "main window close request ignored while previous close handling is active"
                );
            }
            return WindowOperationResult::NoAction;
        };

        if should_log_close_lifecycle() {
            logging!(debug, Type::Window, "main window close requested");
        }

        let Some(window) = Self::get_main_window() else {
            if should_log_close_warning() {
                logging!(
                    warn,
                    Type::Window,
                    "main window close requested but main window was not found"
                );
            }
            return WindowOperationResult::Failed;
        };

        if !Self::is_main_tray_available() {
            let should_log_warning = should_log_close_warning();
            if should_log_warning {
                logging!(
                    warn,
                    Type::Window,
                    "main tray unavailable; minimizing main window instead of hiding to tray"
                );
            }
            return Self::minimize_window_for_close(&window, should_log_warning);
        }

        match window.hide() {
            Ok(()) => {
                if should_log_close_lifecycle() {
                    logging!(debug, Type::Window, "main window hidden to tray");
                }
                WindowOperationResult::Hidden
            }
            Err(err) => {
                let should_log_warning = should_log_close_warning();
                if should_log_warning {
                    logging!(
                        warn,
                        Type::Window,
                        "hide to tray failed; minimizing main window instead: {}",
                        err
                    );
                }
                Self::minimize_window_for_close(&window, should_log_warning)
            }
        }
    }

    fn minimize_window_for_close(window: &WebviewWindow<Wry>, should_log_warning: bool) -> WindowOperationResult {
        match window.minimize() {
            Ok(()) => {
                if should_log_close_lifecycle() {
                    logging!(debug, Type::Window, "main window minimized after close request");
                }
                WindowOperationResult::Minimized
            }
            Err(err) => {
                if should_log_warning {
                    logging!(
                        warn,
                        Type::Window,
                        "failed to minimize main window after close request; leaving it visible: {}",
                        err
                    );
                }
                WindowOperationResult::Failed
            }
        }
    }

    /// 智能显示主窗口
    pub async fn show_main_window() -> WindowOperationResult {
        // 防抖检查
        if !should_handle_window_operation() {
            return WindowOperationResult::NoAction;
        }

        logging!(info, Type::Window, "开始智能显示主窗口");
        logging!(debug, Type::Window, "{}", Self::get_window_status_info());

        let current_state = Self::get_main_window_state();

        match current_state {
            WindowState::NotExist => {
                logging!(info, Type::Window, "窗口不存在，创建新窗口");
                if Self::create_window(true).await {
                    logging!(info, Type::Window, "窗口创建成功");
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    WindowOperationResult::Created
                } else {
                    logging!(warn, Type::Window, "窗口创建失败");
                    WindowOperationResult::Failed
                }
            }
            WindowState::VisibleFocused => {
                logging!(info, Type::Window, "窗口已经可见且有焦点，无需操作");
                WindowOperationResult::NoAction
            }
            WindowState::VisibleUnfocused | WindowState::Minimized | WindowState::Hidden => {
                let (window, state_after_check) = Self::get_main_window_with_state();
                if state_after_check == WindowState::VisibleFocused {
                    logging!(info, Type::Window, "窗口在检查期间已变为可见和有焦点状态");
                    return WindowOperationResult::NoAction;
                }
                if let Some(window) = window {
                    Self::activate_window(&window)
                } else {
                    WindowOperationResult::Failed
                }
            }
        }
    }

    /// 切换主窗口显示状态（显示/隐藏）
    pub async fn toggle_main_window() -> WindowOperationResult {
        if !should_handle_window_operation() {
            return WindowOperationResult::NoAction;
        }

        let (window, state) = Self::get_main_window_with_state();

        logging!(debug, Type::Window, "当前状态: {:?}", state);

        match state {
            WindowState::NotExist => Self::handle_not_exist_toggle().await,
            WindowState::VisibleFocused | WindowState::VisibleUnfocused => Self::hide_main_window(window.as_ref()),
            WindowState::Minimized | WindowState::Hidden => Self::activate_existing_main_window(window.as_ref()),
        }
    }

    // 窗口不存在时创建新窗口
    async fn handle_not_exist_toggle() -> WindowOperationResult {
        logging!(info, Type::Window, "窗口不存在，将创建新窗口");
        // 由于已经有防抖保护，直接调用内部方法
        if Self::create_window(true).await {
            WindowOperationResult::Created
        } else {
            WindowOperationResult::Failed
        }
    }

    // 隐藏主窗口
    fn hide_main_window(window: Option<&WebviewWindow<Wry>>) -> WindowOperationResult {
        logging!(info, Type::Window, "窗口可见，将隐藏窗口");
        if let Some(window) = window {
            match window.hide() {
                Ok(_) => {
                    logging!(info, Type::Window, "窗口已成功隐藏");
                    WindowOperationResult::Hidden
                }
                Err(e) => {
                    logging!(warn, Type::Window, "隐藏窗口失败: {}", e);
                    WindowOperationResult::Failed
                }
            }
        } else {
            logging!(warn, Type::Window, "无法获取窗口实例");
            WindowOperationResult::Failed
        }
    }

    // 激活已存在的主窗口
    fn activate_existing_main_window(window: Option<&WebviewWindow<Wry>>) -> WindowOperationResult {
        logging!(info, Type::Window, "窗口存在但被隐藏或最小化，将激活窗口");
        if let Some(window) = window {
            Self::activate_window(window)
        } else {
            logging!(warn, Type::Window, "无法获取窗口实例");
            WindowOperationResult::Failed
        }
    }

    /// 激活窗口（取消最小化、显示、设置焦点）
    fn activate_window(window: &WebviewWindow<Wry>) -> WindowOperationResult {
        logging!(info, Type::Window, "开始激活窗口");

        let mut operations_successful = true;

        // 1. 如果窗口最小化，先取消最小化
        if window.is_minimized().unwrap_or(false) {
            logging!(info, Type::Window, "窗口已最小化，正在取消最小化");
            if let Err(e) = window.unminimize() {
                logging!(warn, Type::Window, "取消最小化失败: {}", e);
                operations_successful = false;
            }
        }

        // 2. 显示窗口
        if let Err(e) = window.show() {
            logging!(warn, Type::Window, "显示窗口失败: {}", e);
            operations_successful = false;
        }

        // 3. 设置焦点
        if let Err(e) = window.set_focus() {
            logging!(warn, Type::Window, "设置窗口焦点失败: {}", e);
            operations_successful = false;
        }

        // 4. 平台特定的激活策略
        #[cfg(target_os = "macos")]
        {
            logging!(info, Type::Window, "应用 macOS 特定的激活策略");
            handle::Handle::global().set_activation_policy_regular();
        }

        #[cfg(target_os = "windows")]
        {
            // Windows 尝试额外的激活方法
            if let Err(e) = window.set_always_on_top(true) {
                logging!(debug, Type::Window, "设置置顶失败（非关键错误）: {}", e);
            }
            // 立即取消置顶
            if let Err(e) = window.set_always_on_top(false) {
                logging!(debug, Type::Window, "取消置顶失败（非关键错误）: {}", e);
            }
        }

        if operations_successful {
            logging!(info, Type::Window, "窗口激活成功");
            WindowOperationResult::Shown
        } else {
            logging!(warn, Type::Window, "窗口激活部分失败");
            WindowOperationResult::Failed
        }
    }

    /// 检查窗口是否可见
    pub fn is_main_window_visible(window: Option<&WebviewWindow<Wry>>) -> bool {
        window.map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)
    }

    /// 检查窗口是否有焦点
    pub fn is_main_window_focused(window: Option<&WebviewWindow<Wry>>) -> bool {
        window.map(|w| w.is_focused().unwrap_or(false)).unwrap_or(false)
    }

    /// 检查窗口是否最小化
    pub fn is_main_window_minimized(window: Option<&WebviewWindow<Wry>>) -> bool {
        window.map(|w| w.is_minimized().unwrap_or(false)).unwrap_or(false)
    }

    /// 创建新窗口,防抖避免重复调用
    pub fn create_window(is_show: bool) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        Box::pin(async move {
            logging!(info, Type::Window, "开始创建/显示主窗口, is_show={}", is_show);

            if !is_show {
                return false;
            }

            let window = match build_new_window().await {
                Ok(window) => {
                    logging!(info, Type::Window, "新窗口创建成功");
                    window
                }
                Err(e) => {
                    logging!(error, Type::Window, "新窗口创建失败: {}", e);
                    return false;
                }
            };

            // 直接激活刚创建的窗口，避免因防抖导致首次显示被跳过
            if WindowOperationResult::Failed == Self::activate_window(&window) {
                return false;
            }

            true
        })
    }

    /// 摧毁窗口
    pub fn destroy_main_window() -> WindowOperationResult {
        if let Some(window) = Self::get_main_window() {
            let _ = window.destroy();
            logging!(info, Type::Window, "窗口已摧毁");
            #[cfg(target_os = "macos")]
            {
                logging!(info, Type::Window, "应用 macOS 特定的激活策略");
                handle::Handle::global().set_activation_policy_accessory();
            }
            return WindowOperationResult::Destroyed;
        }
        WindowOperationResult::Failed
    }

    /// 获取详细的窗口状态信息
    fn get_window_status_info() -> String {
        let (window, state) = Self::get_main_window_with_state();
        let is_visible = Self::is_main_window_visible(window.as_ref());
        let is_focused = Self::is_main_window_focused(window.as_ref());
        let is_minimized = Self::is_main_window_minimized(window.as_ref());

        format!("窗口状态: {state:?} | 可见: {is_visible} | 有焦点: {is_focused} | 最小化: {is_minimized}")
    }
}
