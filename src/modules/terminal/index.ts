// The terminal's interface: a window's session (making, mounting, focusing, moving and closing one),
// sending text to it, its look, the Tour's demo agent, the agent windows the MCP endpoint opens, and
// what Remote Control and Agent Worktrees read from a session.

export { startAgentWindows } from "./agentwin";
export {
  applyTerminalClear, applyTerminalLook, askDemo, closeSession, ensureSession, focusSession, followAfterTurn, hasSelection,
  mountSession, moveSessions, pasteText, rehomeSession, screenTail, sendText, setLinkHandler, unmountSession,
} from "./terms";
