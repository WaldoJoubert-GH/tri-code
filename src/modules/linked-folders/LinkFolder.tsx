// The Link folder dialog: pick a folder to show beside the project's own in the Editor Window's
// tree and Go to File (links.ts). A project on an ssh Environment first picks where the folder is:
// on that host, beside the project, or on this machine. Also changes an existing link's folder
// ("Change Folder…", or a click on one that is not found). Chosen from design/linked-folders.html.

import { Show, createSignal, onMount } from "solid-js";
import { type LinkedFolder, type Project, addLink, envName, isRemote, projectById, repoOf, updateLink } from "../../shared/state/state";
import { linkName, linkProblem } from "../../shared/links";
import { FolderPicker } from "../../OpenProject";
import { Icon } from "../../shared/ui/lucide";
import { Modal } from "../../shared/ui/Modal";
import { Key } from "../../shared/keys/Keys";
import { flash } from "../../shared/ui/ui";
import { isEnter } from "../../shared/ui/enterkey";

/** The project the dialog links to, and the link it changes (unset: a new one). */
const [target, setTarget] = createSignal<{ projectId: string; linkId?: string } | null>(null);

export const linkDialogOpen = () => target() !== null;
export const closeLinkDialog = () => setTarget(null);
/** Link a folder to `project`, or, with `link`, pick a new folder for it. */
export const openLinkDialog = (project: Project, link?: LinkedFolder) => setTarget({ projectId: project.id, linkId: link?.id });

const parentOf = (path: string) => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || "/";

/** Mount once (in App). */
export function LinkFolderDialog() {
  return (
    <Show when={target()} keyed>
      {(t) => (
        <Show when={projectById(t.projectId)}>
          {(p) => <Dialog project={p()} link={repoOf(p()).links?.find((l) => l.id === t.linkId)} />}
        </Show>
      )}
    </Show>
  );
}

function Dialog(props: { project: Project; link?: LinkedFolder }) {
  const p = props.project;
  const remote = isRemote(p);
  const [local, setLocal] = createSignal(!!props.link?.local && remote);
  /** The folder the picker is in: what Enter on an empty filter, or the Link button, links. */
  const [here, setHere] = createSignal("");
  /** The name typed; empty follows the folder. */
  const [typed, setTyped] = createSignal(props.link?.name ?? "");
  const [readOnly, setReadOnly] = createSignal(!!props.link?.readOnly);
  const [index, setIndex] = createSignal(!props.link?.noIndex);
  const host = () => (local() ? "local" : p.host);
  const nameFor = (path: string) => typed().trim() || linkName(p, path, props.link?.id);
  const problem = (path: string) => linkProblem(p, path, local(), props.link?.id);

  const link = (path: string) => {
    const why = problem(path);
    if (why) return flash(why);
    const name = nameFor(path);
    const fields = { name, path, local: local() ? (true as const) : undefined, readOnly: readOnly() ? (true as const) : undefined, noIndex: index() ? undefined : (true as const) };
    const owner = repoOf(p).id;
    if (props.link) updateLink(owner, props.link.id, fields);
    else addLink(owner, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Omit<LinkedFolder, "id">);
    flash(props.link ? `${name} now shows ${path}` : `linked ${name}`);
    closeLinkDialog();
  };

  let box!: HTMLDivElement;
  onMount(() => box.querySelector<HTMLElement>(".picker .q")?.focus());

  return (
    <Modal label="Link folder" onClose={closeLinkDialog}>
      <div class="wt-dlg link-dlg" ref={box}>
        <header>
          <span><Icon name="folder-symlink" size={14} />{props.link ? `Change the folder ${props.link.name} shows` : `Link a folder to ${p.name}`}</span>
          <button type="button" title="Close (Esc)" aria-label="Close" onClick={closeLinkDialog}>×</button>
        </header>
        <div class="lbody">
          <Show when={remote}>
            <div class="mt">Where is it?</div>
            <div class="where" role="radiogroup" aria-label="Where the folder is">
              <button type="button" class="opt" role="radio" aria-checked={!local()} onClick={() => setLocal(false)}>
                <Icon name="server" size={15} />
                <span><b>On {envName(p.host)}</b><span>Beside the project. Its terminals and agents can use it.</span></span>
              </button>
              <button type="button" class="opt here" role="radio" aria-checked={local()} onClick={() => setLocal(true)}>
                <Icon name="laptop" size={15} />
                <span><b>On this machine</b><span>Read here and shown in the editor. {envName(p.host)} can't see it.</span></span>
              </button>
            </div>
          </Show>
          <div class="mt">Folder</div>
          <Show when={host()} keyed>
            {(h) => (
              <FolderPicker
                host={h}
                pick
                autofocus
                useLabel="link"
                start={props.link && !!props.link.local === local() ? parentOf(props.link.path) : undefined}
                onList={(l) => setHere(l.path)}
                onHere={link}
                onOpen={link}
                footer={
                  <>
                    <span class="here" title={here()}><bdi>{here()}</bdi></span>
                    <Show when={here() && problem(here())}><span class="lwarn">{problem(here())}</span></Show>
                    <button type="button" class="primary" disabled={!here() || !!problem(here())} onClick={() => link(here())}>
                      {props.link ? "Use this folder" : "Link this folder"}
                    </button>
                  </>
                }
                keys={
                  <>
                    <span><Key k="↵" /> in / link this folder</span>
                    <span><Key k="⌫" /> up</span>
                    <span><Key k="Ctrl" /><Key k="↵" /> link highlighted</span>
                  </>
                }
              />
            )}
          </Show>
          <div class="opts">
            <label class="nm">
              <span>Name in the tree</span>
              <input
                value={typed()}
                placeholder={here() ? linkName(p, here(), props.link?.id) : "follows the folder"}
                spellcheck={false}
                autocomplete="off"
                onInput={(e) => setTyped(e.currentTarget.value)}
                onKeyDown={(e) => isEnter(e) && here() && link(here())}
              />
            </label>
            <label class="chk"><input type="checkbox" checked={readOnly()} onChange={(e) => setReadOnly(e.currentTarget.checked)} /> Read-only in the editor</label>
            <label class="chk"><input type="checkbox" checked={index()} onChange={(e) => setIndex(e.currentTarget.checked)} /> Include in Go to File</label>
          </div>
          <Show when={remote && local()}>
            <div class="lnote">
              <Icon name="info" size={13} />
              <span>Terminals and agents on {envName(p.host)} can't reach a folder on this machine. tri-code reads and saves its files here.</span>
            </div>
          </Show>
        </div>
      </div>
    </Modal>
  );
}
