// The editor status bar's language picker, like VS Code's Select Language Mode: the languages a file
// can be shown in now (built in and installed grammars), then the grammars that can be installed.
// Picking one shows the file in it until tri-code restarts; an uninstalled one installs first.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { BUILTIN, type LangKey, autoKey, languageKey, offerFor } from "./cm";
import { LANGS, downloadSize, kb } from "./grammars";
import { installLang, installedGrammars, installing, installError, isInstalled, setOverride } from "./langs";
import { isEnter } from "./shared/ui/enterkey";

type Item = { key: LangKey; name: string; types: string; install?: string };

/** A language's file types as a short hint: `.zig .zon`. */
const typesText = (types: readonly string[]) => types.slice(0, 4).map((t) => (/^[a-z0-9]+$/i.test(t) && !/^[A-Z]/.test(t) ? `.${t}` : t)).join(" ");

export default function LangPicker(props: { path: string; anchor: HTMLElement; onClose: () => void }) {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let el!: HTMLDivElement, input!: HTMLInputElement;

  const items = createMemo(() => {
    const words = q().trim().toLowerCase();
    const hit = (i: Item) => !words || i.name.toLowerCase().includes(words) || i.types.toLowerCase().includes(words);
    const have: Item[] = [
      { key: "", name: "Plain text", types: "" },
      ...BUILTIN.map((d) => ({ key: `b:${d.name}`, name: d.name, types: typesText(d.extensions) })),
      ...LANGS.filter((l) => isInstalled(l.id)).map((l) => ({ key: `t:${l.id}`, name: l.name, types: typesText(l.types) })),
    ].sort((a, b) => (a.key === "" ? -1 : b.key === "" ? 1 : a.name.localeCompare(b.name)));
    const offer = offerFor(props.path);
    const more: Item[] = LANGS.filter((l) => !isInstalled(l.id))
      .map((l) => ({ key: `t:${l.id}`, name: l.name, types: typesText(l.types), install: l.id }))
      // The file's own language first: it is the likely pick.
      .sort((a, b) => (a.install === offer?.id ? -1 : b.install === offer?.id ? 1 : 0));
    return { have: have.filter(hit), more: more.filter(hit) };
  });
  const flat = () => [...items().have, ...items().more];
  const current = () => languageKey(props.path);

  async function choose(i: Item) {
    if (i.install) {
      if (!(await installLang(i.install))) return;
    }
    // The language the file would get by itself isn't a pick, so it follows later installs.
    setOverride(props.path, i.key === autoKey(props.path) ? undefined : i.key);
    props.onClose();
  }

  const onKey = (e: KeyboardEvent) => {
    const n = flat().length;
    if (e.key === "ArrowDown") setSel((s) => Math.min(n - 1, s + 1));
    else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
    else if (isEnter(e)) flat()[sel()] && void choose(flat()[sel()]);
    else if (e.key === "Escape") props.onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
    el.querySelector(".lp-row.sel")?.scrollIntoView({ block: "nearest" });
  };

  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) props.onClose();
  };
  onMount(() => {
    document.addEventListener("pointerdown", onDown, true);
    const r = props.anchor.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + "px";
    el.style.top = Math.max(8, r.top - el.offsetHeight - 4) + "px";
    input.focus();
  });
  onCleanup(() => document.removeEventListener("pointerdown", onDown, true));

  const row = (i: Item, at: () => number) => (
    <button
      type="button"
      class="lp-row"
      classList={{ sel: at() === sel() }}
      onPointerMove={() => setSel(at())}
      onClick={() => void choose(i)}
    >
      <span class="lp-nm">{i.name}</span>
      <span class="lp-ty">{i.types}</span>
      <Show when={i.install} fallback={<Show when={i.key === current()}><span class="lp-act cur">current</span></Show>}>
        {(id) => (
          <span class="lp-act">
            {installing()?.id === id() ? `${Math.round((installing()!.done / installing()!.total) * 100)}%` : `Install · ${kb(downloadSize(id(), installedGrammars()))}`}
          </span>
        )}
      </Show>
    </button>
  );

  return (
    <Portal>
    <div class="lang-picker" role="dialog" aria-label="Select language" ref={el} onKeyDown={onKey}>
      <input
        ref={input}
        placeholder="Select a language, or install one"
        spellcheck={false}
        value={q()}
        onInput={(e) => (setQ(e.currentTarget.value), setSel(0))}
      />
      <div class="lp-list">
        <Show when={items().have.length}>
          <div class="lp-grp">Built in and installed</div>
          <For each={items().have}>{(i, k) => row(i, k)}</For>
        </Show>
        <Show when={items().more.length}>
          <div class="lp-grp">Available to install</div>
          <For each={items().more}>{(i, k) => row(i, () => items().have.length + k())}</For>
        </Show>
        <Show when={!flat().length}>
          <div class="lp-note">No language matches “{q()}”.</div>
        </Show>
      </div>
      <Show when={installError()}>
        {(f) => <div class="lp-note bad">Couldn't install {f().id}: {f().msg.split("\n")[0]}</div>}
      </Show>
    </div>
    </Portal>
  );
}
