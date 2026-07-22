use anyhow::Result;
use smartstring::alias::String;

pub type CmdResult<T = ()> = Result<T, String>;

// Command modules
pub mod app;
pub mod clash;
pub mod lightweight;
pub mod network;
pub mod profile;
pub mod proxy;
pub mod runtime;
pub mod secure_session;
pub mod service;
pub mod system;
pub mod verge;

// Re-export all command functions for backwards compatibility
pub use app::*;
pub use clash::*;
pub use lightweight::*;
pub use network::*;
pub use profile::*;
pub use proxy::*;
pub use runtime::*;
pub use secure_session::*;
pub use service::*;
pub use system::*;
pub use verge::*;

pub trait StringifyErr<T> {
    fn stringify_err(self) -> CmdResult<T>;
}

impl<T, E: std::fmt::Display> StringifyErr<T> for Result<T, E> {
    fn stringify_err(self) -> CmdResult<T> {
        self.map_err(|e| e.to_string().into())
    }
}
