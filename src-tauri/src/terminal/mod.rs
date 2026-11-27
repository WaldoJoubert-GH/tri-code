//! Terminals: the app's PTY sessions (`pty`) and the terminal host that owns the PTYs (`ptyd`).
//! `ptyd` is public: `main.rs` runs it when the executable is started as the host.

pub(crate) mod pty;
pub mod ptyd;
