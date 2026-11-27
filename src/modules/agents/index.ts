// Commands' interface (`Agent` in code): launching one and its hotkeys and scopes, the Commands
// window and Settings › Commands, Agent Setup (installing an agent, the banner), and which agent
// window "send to agent" picks.

export { AgentsPage } from "./AgentSettings";
export { default as AgentsPanel } from "./AgentsPanel";
export { SetupBanner } from "./SetupBanner";
export { seedAgentKeys } from "./agentkeys";
export {
  agentForKey, hotkeyKeys, hotkeyProblem, launchAgent, looksLikeUrl, newShell, offeredIn, offeredTogether, openAgentsPanel,
  recording, scopeLabel, setRecording,
} from "./agents";
export { installAgent, refreshSetup, setupBusy, setupError, setupStatus, startAgentSetup } from "./agentsetup";
export { agentTarget, agentWindows, rememberAgent, trackAgentFocus } from "./agenttarget";
