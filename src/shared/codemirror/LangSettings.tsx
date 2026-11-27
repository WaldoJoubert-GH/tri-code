// Settings › Languages: whether the editor offers grammars, the ones installed, and every one the
// Grammar Catalog can install. Chosen from design/language-grammars.html.

import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { BUILTIN } from "./cm";
import { GRAMMARS, LANGS, VERSION, downloadSize, kb, type Lang } from "./grammars";
import {
  installError, installLang, installedGrammars, installing, isInstalled, loadInstalled, neverSuggest, removeLang, setNever, setSuggesting, suggesting,
} from "./langs";

const types = (l: Lang) => l.types.slice(0, 5).map((t) => (/^[a-z0-9]+$/.test(t) ? `.${t}` : t)).join(" ");

export function LanguagesPage() {
  const [q, setQ] = createSignal("");
  onMount(() => void loadInstalled());

  const installed = createMemo(() => LANGS.filter((l) => isInstalled(l.id)));
  const available = createMemo(() => {
    const w = q().trim().toLowerCase();
    return LANGS.filter((l) => !isInstalled(l.id) && (!w || l.name.toLowerCase().includes(w) || l.types.some((t) => t.toLowerCase().includes(w))));
  });

  const pct = () => {
    const p = installing();
    return p ? Math.round((p.done / p.total) * 100) : 0;
  };

  const row = (l: Lang, installedRow: boolean) => (
    <div class="row lang-row">
      <span class="lang-tx">
        <b>
          {l.name}
          <Show when={neverSuggest(l.id)}><span class="lang-pill" title="The editor doesn't offer this one">not suggested</span></Show>
        </b>
        <span class="lang-ty">{types(l)}</span>
      </span>
      <span class="lang-size">{kb(installedRow ? GRAMMARS[l.id].bytes : downloadSize(l.id, installedGrammars()))}</span>
      <Show when={neverSuggest(l.id)}>
        <button type="button" class="set-btn" onClick={() => setNever(l.id, false)}>Suggest again</button>
      </Show>
      <Show
        when={installedRow}
        fallback={
          <button type="button" class="set-btn" disabled={!!installing()} onClick={() => void installLang(l.id)}>
            {installing()?.id === l.id ? `${pct()}%` : "Install"}
          </button>
        }
      >
        <button type="button" class="set-btn" onClick={() => void removeLang(l.id)}>Remove</button>
      </Show>
    </div>
  );

  return (
    <>
      <h4>Suggestions</h4>
      <div class="row">
        Offer a grammar when a file has none
        <span class="set-seg" role="radiogroup" aria-label="Offer grammars">
          <For each={[[true, "On"], [false, "Off"]] as const}>
            {([on, label]) => (
              <button type="button" role="radio" aria-checked={suggesting() === on} onClick={() => setSuggesting(on)}>{label}</button>
            )}
          </For>
        </span>
      </div>
      <p class="note">
        Opening a file tri-code has no highlighting for shows a bar above it to install one, once per language. Off, nothing is offered,
        and you can still install from here or from the language in the editor's status bar.
      </p>

      <h4>Installed</h4>
      <Show when={installed().length} fallback={<p class="note">None yet. Install one below, or from the bar above a file that has none.</p>}>
        <div class="lang-list"><For each={installed()}>{(l) => row(l, true)}</For></div>
      </Show>
      <Show when={installError()}>
        {(f) => <p class="lang-err">Couldn't install {f().id}: {f().msg}</p>}
      </Show>

      <h4>Available</h4>
      <input
        class="lang-q"
        type="search"
        placeholder={`Search ${LANGS.length} languages or file types`}
        spellcheck={false}
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <div class="lang-list">
        <For each={available()} fallback={<p class="note">No language matches “{q()}”.</p>}>{(l) => row(l, false)}</For>
      </div>
      <p class="note">
        The TextMate grammars VS Code extensions use, from tm-grammars {VERSION}. Each is downloaded once, checked against the hash tri-code
        ships with, and kept on this computer, so remote projects use it too. Web languages bring the HTML, CSS and script grammars they need.
      </p>

      <h4>Built in</h4>
      <p class="lang-builtin">{BUILTIN.map((d) => d.name).join(", ")}</p>
    </>
  );
}
