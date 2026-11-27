// The browser window's interface: its pages and their webviews (placing, navigating, covering and
// closing them), opening a URL in a project or outside, Browser Profiles, Favourites, downloads, the
// Debug Menu, passwords, screenshots, and Remote Tunnels. Canvas draws most of the window from these
// parts, which is why the list is long.

export {
  addressToUrl, answerPassword, browserBack, browserForward, browserInfo, browserKeys, browserReload, closeBrowser, closePage,
  consoleErrors, debugPortOf, debugSupport, focusApp, focusPage, nativeBrowsers, navigateBrowser, openExternal, openExternalIn,
  openUrlInProject, pageOfLabel, passwordPrompts, pickElement, placeBrowser, profilesKey, profilesSupported, screenshotPage,
  setBrowsersCovered, setBrowsersOverlaid, setBrowsersSuspended,
} from "./browsers";
export { DebugButton, DebugMenu, closeDebugMenu, debugMenuOpen } from "./debugmenu";
export { DownloadBar, DownloadButton, DownloadMenu, closeDownloadMenu, downloadMenuOpen, forgetDownloads } from "./downloads";
export { FavBar, FavPopover, StartPage, closeFavEdit, favEditFor, favEditOpen, starPage } from "./favs";
export {
  BrowserPage, ProfileAvatar, ProfileMenu, closeProfileMenu, profileColor, profileMenuOpen, profilesInUse, toggleProfileMenu,
} from "./profiles";
export { fileUrlOf } from "./tunnelmap";
export { fwdOfPage, heldBy } from "./tunnels";
export { RemoteStart, TunnelBar, TunnelChip, TunnelHeld, TunnelPopover, closeTunnelPop, tunnelPopOpen } from "./tunnelui";
