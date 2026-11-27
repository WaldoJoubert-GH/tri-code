// The first two commands' hotkeys: Alt+A for the first and Alt+Shift+A for the second. New state
// files start with them (defaultAgents); older ones get them once, here.

import { FIRST_AGENT_KEYS, app, setAgentKeys, updateAgent } from "./shared/state/state";
import { owner, sameChord } from "./keymap";

/** Once per state.json (after loadState): each of the first two commands gets its key if it has
 *  no hotkey and no action or other command holds that chord. A key removed later stays removed. */
export function seedAgentKeys() {
  if (app.agentKeys) return;
  app.agents.slice(0, FIRST_AGENT_KEYS.length).forEach((a, i) => {
    const k = FIRST_AGENT_KEYS[i];
    if (a.hotkey || owner(k) || app.agents.some((b) => b.hotkey && sameChord(b.hotkey, k))) return;
    updateAgent(a.id, { hotkey: { ...k } });
  });
  setAgentKeys();
}
