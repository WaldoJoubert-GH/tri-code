// Agent Signals' interface: a window's signal and its text, stepping to the next one, the events and
// their sounds, the alert hook Remote Control registers with, Do Not Disturb, and the signals popover
// and Settings › Signals form.

export { SignalsForm, SignalsPopover, closeSignals, signalsOpen, toggleSignals } from "./SignalSettings";
export { SoundSelect } from "./SoundSelect";
export {
  EVENTS, SIG_TEXT, applySignalColors, nextSignal, onAlert, onSignal, playFor, playSound, reloadSound, sigOf, sigSummary,
  soundFor, soundName, toggleDnd, topSig,
} from "./signals";
