// Leftovers' interface: the status-line chip, the sidebar count and the popover, the scan the
// terminal and Worktrees trigger, and ending what still holds a Worktree's folder.

export { LeftoverCount, LeftoversChip, LeftoversPopover } from "./LeftoversPopover";
export {
  closeLeftovers, endHolders, endLeftover, holderLine, holdersOf, leftoversOpen, rescanSoon, samePath, scanLeftovers,
  staleCheckouts, watchLeftovers,
} from "./leftovers";
