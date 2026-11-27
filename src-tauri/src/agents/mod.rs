//! Commands (agents) in terminals: installing them (`agent_setup`), the MCP endpoint through which
//! an agent opens its own terminal windows (`agent_windows`), and reopening a conversation (`resume`).

pub(crate) mod agent_setup;
pub(crate) mod agent_windows;
pub(crate) mod resume;
