// Settings › News: the topics the News Window lists its feeds under. Renaming a topic moves its
// feeds with it; removing one moves them to the first topic left (news.ts).

import { For, Show, createSignal } from "solid-js";
import { app } from "../../shared/state/state";
import { feeds, newTopic, removeTopic, renameTopic, resetTopics, shiftTopic, topics } from "./news";
import { Caps } from "../../shared/keys/Keys";
import { isEnter } from "../../shared/ui/enterkey";

export function NewsPage() {
  const [draft, setDraft] = createSignal("");
  const count = (t: string) => feeds().filter((f) => f.topic === t).length;

  function add(e: Event) {
    e.preventDefault();
    if (newTopic(draft())) setDraft("");
  }

  return (
    <>
      <h4>Topics</h4>
      <p class="note">
        The headings the News Window (<Caps id="news" />) lists feeds under, in this order. Renaming one moves its feeds with it; removing one moves its feeds to the first topic left.
      </p>
      <ol class="nw-topics">
        <For each={topics()}>
          {(t, i) => (
            <li>
              <input
                value={t}
                spellcheck={false}
                aria-label={`Topic ${t}`}
                onChange={(e) => {
                  const to = e.currentTarget.value.trim();
                  if (!to) e.currentTarget.value = t;
                  else renameTopic(t, to);
                }}
                onKeyDown={(e) => {
                  if (isEnter(e)) e.currentTarget.blur();
                  if (e.key === "Escape") { e.currentTarget.value = t; e.currentTarget.blur(); e.stopPropagation(); }
                }}
              />
              <span class="nw-topic-n">{count(t) === 1 ? "1 feed" : `${count(t)} feeds`}</span>
              <button type="button" title="Up" aria-label={`Move ${t} up`} disabled={i() === 0} onClick={() => shiftTopic(t, -1)}>↑</button>
              <button type="button" title="Down" aria-label={`Move ${t} down`} disabled={i() === topics().length - 1} onClick={() => shiftTopic(t, 1)}>↓</button>
              <button
                type="button"
                title={count(t) ? `Remove; its feeds move to ${topics().find((x) => x !== t)}` : "Remove"}
                aria-label={`Remove ${t}`}
                disabled={topics().length === 1}
                onClick={() => removeTopic(t)}
              >
                ×
              </button>
            </li>
          )}
        </For>
      </ol>
      <form class="nw-topic-add" onSubmit={add}>
        <input placeholder="New topic" value={draft()} spellcheck={false} onInput={(e) => setDraft(e.currentTarget.value)} />
        <button type="submit" disabled={!draft().trim() || topics().includes(draft().trim())}>Add</button>
        <Show when={app.newsTopics}>
          <button type="button" class="reset" title="Back to World, Local, Tech, Business, Science, Other" onClick={resetTopics}>↺</button>
        </Show>
      </form>
    </>
  );
}
