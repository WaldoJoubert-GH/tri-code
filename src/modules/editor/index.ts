// The Editor Window's interface: the window itself (lazy), opening an editor or a file, its dirty
// count, the files Go to File lists, the file-type icons the palette and Settings draw, the Markdown
// export options Appearance edits, and the file reads Remote Control answers with.

import { lazy } from "solid-js";

/** CodeMirror and its languages load the first time an editor window opens. */
export const Editor = lazy(() => import("./Editor"));
export { FileIcon, iconOpts } from "./FileList";
export { type FsList, type FsText, dirtyCount, dropEditor, filesOf, openEditor, openFile } from "./files";
export { CSS_HINT, DEFAULT_MARGIN, PAGES, printDocument } from "./mdexport";
