use clash_verge_i18n::t;
use std::borrow::Cow;

macro_rules! define_menu {
    ($($field:ident => $const_name:ident, $id:expr, $text:expr),+ $(,)?) => {
        #[derive(Debug)]
        pub struct MenuTexts {
            $(pub $field: Cow<'static, str>,)+
        }

        pub struct MenuIds;

        impl MenuTexts {
            pub fn new() -> Self {
                Self {
                    $($field: t!($text),)+
                }
            }
        }

        impl MenuIds {
            $(pub const $const_name: &'static str = $id;)+
        }
    };
}

define_menu! {
    dashboard => DASHBOARD, "tray_dashboard", "tray.dashboard",
    system_proxy => SYSTEM_PROXY, "tray_system_proxy", "tray.systemProxy",
    tun_mode => TUN_MODE, "tray_tun_mode", "tray.tunMode",
    close_all_connections => CLOSE_ALL_CONNECTIONS, "tray_close_all_connections", "tray.closeAllConnections",
    restart_app => RESTART_APP, "tray_restart_app", "tray.restartApp",
    verge_version => VERGE_VERSION, "tray_verge_version", "tray.vergeVersion",
    exit => EXIT, "tray_exit", "tray.exit",
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum TrayAction {
    SystemProxy,
    TunMode,
    MainWindow,
    TrayMenu,
    Unknown,
}

impl From<&str> for TrayAction {
    fn from(s: &str) -> Self {
        match s {
            "system_proxy" => Self::SystemProxy,
            "tun_mode" => Self::TunMode,
            "main_window" => Self::MainWindow,
            "tray_menu" => Self::TrayMenu,
            _ => Self::Unknown,
        }
    }
}
