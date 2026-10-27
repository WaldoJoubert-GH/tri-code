// The Database Window (ADR 0004, design/database-window.html): one Connection per window. A
// schema tree on the left; Data (a paged grid with Pending Edits), Query and Structure on the
// right. Without a Connection the window shows the project's Connections and the form.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, bracketMatching } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { json } from "@codemirror/lang-json";
import { type Project, type Tab, isRemote, newId, setTabDb } from "./state";
import {
  type DbConn, type DbTarget, type EnvVar, type Obj, type ResultSet, type Win, addRow, apply, cancelQuery, closeReview, connOf, connsOf, discard,
  envVars, loadConns, loadPage, loadSchema, openObj, openSession, pendingOf, removeConn, review, rowObj, runQuery, saveConn, setCell, setDoc,
  setFilter, setQuery, setResTab, setSelCell, setView, structOf, testConn, toggleDelete, toggleGroup, toggleSort, turnPage, undo, wins,
} from "./db";
import { type Cell, type DbKind, cellText, editText, isNested, isOpaque, parseInput, pendingCount, rowKey, writes } from "./dbsql";
import { Icon } from "./lucide";
import { highlight, theme } from "./cm";
import { ask, flash } from "./ui";
import "./db.css";

const KIND_LABEL: Record<DbKind, string> = { postgres: "PG", sqlite: "SQLITE", mongo: "MONGO" };
const KIND_NAME: Record<DbKind, string> = { postgres: "PostgreSQL", sqlite: "SQLite", mongo: "MongoDB" };
const OBJ_ICON: Record<Obj["kind"], string> = { table: "table-2", view: "eye", system: "table-2", collection: "braces" };

const targetText = (t: DbTarget) => ("env" in t ? `.env ${t.env}` : "url" in t ? t.url.replace(/:[^:@/]*@/, ":•••@") : t.file);
const fmtCount = (n: number | null) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

export default function DbPanel(props: { project: Project; tab: Tab; focused: boolean }): JSX.Element {
  const p = () => props.project;
  const id = props.tab.id;
  const conn = () => connOf(p(), props.tab.db);
  const w = () => wins[id];
  const [form, setForm] = createSignal<DbConn | "new" | null>(null);

  onMount(() => {
    if (!connsOf(p())) loadConns(p());
  });
  // Open the Session once the Connection is known (and again when it changes).
  createEffect(on(() => [props.tab.db, conn()?.id, JSON.stringify(conn() ?? null)] as const, ([db, cid]) => {
    if (db && cid) openSession(p(), props.tab, !!wins[id] && wins[id].status === "error");
  }));

  return (
    <div class="dbwin" classList={{ prod: conn()?.tag === "prod" }}>
      <Show when={form()} fallback={
        <Show when={props.tab.db ? conn() : undefined} fallback={<StartPage project={p()} tab={props.tab} missing={!!props.tab.db && !!connsOf(p())} onNew={() => setForm("new")} onEdit={(c) => setForm(c)} />}>
          {(c) => <Main project={p()} tab={props.tab} conn={c()} win={w()} focused={props.focused} onEdit={() => setForm(c())} />}
        </Show>
      }>
        {(f) => (
          <ConnForm
            project={p()}
            conn={f() === "new" ? undefined : (f() as DbConn)}
            onDone={(saved) => {
              setForm(null);
              if (saved) {
                setTabDb(p().id, id, saved.id);
                openSession(p(), { ...props.tab, db: saved.id }, true);
              }
            }}
            onRemove={async (c) => {
              if (!(await ask(`Remove the Connection ${c.name}? Its password on ${p().host} is forgotten too.`))) return;
              await removeConn(p(), c.id);
              setForm(null);
              setTabDb(p().id, id, undefined);
            }}
          />
        )}
      </Show>
    </div>
  );
}

// ── start page ──────────────────────────────────────────────────────

function StartPage(props: { project: Project; tab: Tab; missing: boolean; onNew: () => void; onEdit: (c: DbConn) => void }): JSX.Element {
  const list = () => connsOf(props.project) ?? [];
  return (
    <div class="db-start">
      <div class="db-start-in">
        <h3>Databases of {props.project.name}</h3>
        <Show when={props.missing}>
          <div class="db-err">This window's Connection is gone from .dev/databases.json. Pick another.</div>
        </Show>
        <For each={list()} fallback={<p class="muted">No Connections yet. They're saved in <code>.dev/databases.json</code>; passwords stay on {props.project.host === "local" ? "this machine" : props.project.host}.</p>}>
          {(c) => (
            <div class="db-conn-row" role="button" tabindex="0" title={`Open ${c.name}`} onClick={() => setTabDb(props.project.id, props.tab.id, c.id)} onKeyDown={(e) => e.key === "Enter" && setTabDb(props.project.id, props.tab.id, c.id)}>
              <Icon name="database" size={15} />
              <span class="db-grow">
                <b>{c.name}</b> <span class="muted mono">{targetText(c.target)}</span>
              </span>
              <Show when={c.readOnly}><span class="db-pill ro">read-only</span></Show>
              <Show when={c.tag === "prod"}><span class="db-pill prod">prod</span></Show>
              <span class={`db-kind ${c.kind}`}>{KIND_LABEL[c.kind]}</span>
              <button class="db-ib" title="Edit" onClick={(e) => { e.stopPropagation(); props.onEdit(c); }}><Icon name="settings" size={13} /></button>
            </div>
          )}
        </For>
        <button class="db-btn db-pri" onClick={props.onNew}><Icon name="plus" size={13} />New connection</button>
      </div>
    </div>
  );
}

// ── connection form ─────────────────────────────────────────────────

function ConnForm(props: { project: Project; conn?: DbConn; onDone: (c?: DbConn) => void; onRemove: (c: DbConn) => void }): JSX.Element {
  const remote = () => isRemote(props.project);
  const c0 = props.conn;
  const [name, setName] = createSignal(c0?.name ?? "");
  const [kind, setKind] = createSignal<DbKind>(c0?.kind ?? "postgres");
  const [src, setSrc] = createSignal<"env" | "url" | "file">(c0 ? (Object.keys(c0.target)[0] as "env") : "env");
  const [env, setEnv] = createSignal(c0 && "env" in c0.target ? c0.target.env : "");
  const [url, setUrl] = createSignal(c0 && "url" in c0.target ? c0.target.url : "");
  const [file, setFile] = createSignal(c0 && "file" in c0.target ? c0.target.file : "");
  const [pw, setPw] = createSignal("");
  const [via, setVia] = createSignal<"direct" | "host">(c0?.via ?? (remote() ? "host" : "direct"));
  const [ro, setRo] = createSignal(!!c0?.readOnly);
  const [prod, setProd] = createSignal(c0?.tag === "prod");
  const [vars, setVars] = createSignal<EnvVar[]>([]);
  const [test, setTest] = createSignal<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const id = c0?.id ?? newId();

  onMount(() => {
    envVars(props.project).then((v) => {
      setVars(v);
      if (!c0 && v[0]) {
        setEnv(v[0].key);
        setKind(v[0].kind);
        if (v[0].kind === "sqlite" && remote()) setSrc("env");
      }
    }).catch(() => {});
  });
  // SQLite is a file; the other two are a URL (from .env or typed).
  createEffect(on(kind, (k) => {
    if (k === "sqlite" && src() === "url") setSrc("file");
    if (k !== "sqlite" && src() === "file") setSrc("env");
  }, { defer: true }));

  // A test result belongs to what was tested.
  createEffect(on([kind, src, env, url, file, via], () => setTest(null), { defer: true }));
  const sqliteRemote = () => kind() === "sqlite" && remote();
  const build = (): DbConn | null => {
    const target: DbTarget | null = src() === "env" ? (env().trim() ? { env: env().trim() } : null) : src() === "url" ? (url().trim() ? { url: url().trim() } : null) : file().trim() ? { file: file().trim() } : null;
    if (!target) return null;
    return {
      id, kind: kind(), target,
      name: name().trim() || ("env" in target ? target.env.toLowerCase() : "url" in target ? target.url.split("/").pop()?.split("?")[0] || kind() : target.file.split(/[\\/]/).pop() ?? kind()),
      ...(remote() && kind() !== "sqlite" ? { via: via() } : {}),
      ...(ro() ? { readOnly: true } : {}),
      ...(prod() ? { tag: "prod" as const } : {}),
    };
  };
  const secret = () => (src() === "url" && pw() ? pw() : src() === "url" ? undefined : null);

  const doTest = async () => {
    const c = build();
    if (!c) return void setTest({ ok: false, msg: "fill in where it points first" });
    setBusy(true);
    setTest({ ok: true, msg: remote() && c.via === "host" ? `connecting through ${props.project.host}…` : "connecting…" });
    try {
      setTest({ ok: true, msg: `✓ ${await testConn(props.project, c, pw() || undefined)}` });
    } catch (e) {
      setTest({ ok: false, msg: String(e) });
    }
    setBusy(false);
  };
  const doSave = async () => {
    const c = build();
    if (!c) return void setTest({ ok: false, msg: "fill in where it points first" });
    setBusy(true);
    try {
      await saveConn(props.project, c, secret());
      props.onDone(c);
    } catch (e) {
      setTest({ ok: false, msg: String(e) });
    }
    setBusy(false);
  };

  return (
    <div class="db-start">
      <form class="db-form" onSubmit={(e) => { e.preventDefault(); doSave(); }} onKeyDown={(e) => e.key === "Escape" && props.onDone()}>
        <div class="db-form-h">
          <Icon name="database" size={15} />
          <b class="db-grow">{c0 ? `Edit ${c0.name}` : "New connection"}</b>
          <span class="muted">{props.project.name} · {props.project.host}</span>
        </div>
        <label class="db-field"><span>Name</span><input value={name()} placeholder="app" onInput={(e) => setName(e.currentTarget.value)} autofocus /></label>
        <div class="db-field"><span>Kind</span>
          <div class="db-seg">
            <For each={["postgres", "sqlite", "mongo"] as DbKind[]}>
              {(k) => <button type="button" classList={{ on: kind() === k }} onClick={() => setKind(k)}>{KIND_NAME[k]}</button>}
            </For>
          </div>
        </div>
        <Show when={sqliteRemote()}>
          <div class="db-hint warn">SQLite on an ssh host isn't supported yet: the file lives on {props.project.host}.</div>
        </Show>
        <div class="db-field"><span>Target</span>
          <div class="db-seg">
            <button type="button" classList={{ on: src() === "env" }} onClick={() => setSrc("env")}>From .env</button>
            <Show when={kind() !== "sqlite"} fallback={<button type="button" classList={{ on: src() === "file" }} onClick={() => setSrc("file")}>File</button>}>
              <button type="button" classList={{ on: src() === "url" }} onClick={() => setSrc("url")}>URL</button>
            </Show>
          </div>
        </div>
        <Show when={src() === "env"}>
          <label class="db-field"><span>Variable</span>
            <input list={`dbenv-${id}`} value={env()} placeholder="DATABASE_URL" onInput={(e) => setEnv(e.currentTarget.value)} />
            <datalist id={`dbenv-${id}`}><For each={vars()}>{(v) => <option value={v.key}>{KIND_NAME[v.kind]}</option>}</For></datalist>
          </label>
          <div class="db-hint">Read from <code>.env</code> or <code>.env.local</code> on the project's host each time it connects. Nothing is stored.</div>
        </Show>
        <Show when={src() === "url"}>
          <label class="db-field"><span>URL</span><input class="mono" value={url()} placeholder={kind() === "mongo" ? "mongodb://app@mongo.internal:27017/analytics" : "postgres://app@db.internal:5432/app"} onInput={(e) => setUrl(e.currentTarget.value)} /></label>
          <label class="db-field"><span>Password</span><input type="password" value={pw()} placeholder={c0 && "url" in c0.target ? "unchanged" : ""} onInput={(e) => setPw(e.currentTarget.value)} /></label>
          <div class="db-hint">Kept out of <code>.dev/</code>, in <code>~/.tri-code/secrets/databases.json</code> on {remote() ? props.project.host : "this machine"}.</div>
        </Show>
        <Show when={src() === "file"}>
          <div class="db-field"><span>File</span>
            <div class="db-row">
              <input class="mono db-grow" value={file()} placeholder="./data/dev.db" onInput={(e) => setFile(e.currentTarget.value)} />
              <Show when={!remote()}>
                <button type="button" class="db-btn" onClick={async () => {
                  const f = await pickFile({ multiple: false, defaultPath: props.project.path, filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] }, { name: "All files", extensions: ["*"] }] });
                  if (typeof f === "string") setFile(f);
                }}>Browse…</button>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={remote() && kind() !== "sqlite"}>
          <div class="db-field"><span>Connect</span>
            <div class="db-seg">
              <button type="button" classList={{ on: via() === "host" }} onClick={() => setVia("host")}>Through {props.project.host}</button>
              <button type="button" classList={{ on: via() === "direct" }} onClick={() => setVia("direct")}>Direct</button>
            </div>
          </div>
          <div class="db-hint">
            {via() === "host"
              ? <>An ssh tunnel through <b>{props.project.host}</b>, with its key and options, closed with the window.{kind() === "mongo" ? " Uses directConnection=true." : ""}</>
              : <>From this machine: for cloud databases (Neon, Supabase, Atlas <code>mongodb+srv://</code>).</>}
          </div>
        </Show>
        <div class="db-field"><span>Safety</span>
          <div class="db-row">
            <label class="db-check"><input type="checkbox" checked={ro()} onChange={(e) => setRo(e.currentTarget.checked)} /> Read-only</label>
            <label class="db-check"><input type="checkbox" checked={prod()} onChange={(e) => setProd(e.currentTarget.checked)} /> Tag as prod</label>
          </div>
        </div>
        <div class="db-field"><span />
          <div class="db-row">
            <button type="button" class="db-btn" disabled={busy() || sqliteRemote()} onClick={doTest}><Icon name="plug" size={13} />Test</button>
            <span class="db-test mono" classList={{ bad: test()?.ok === false }}>{test()?.msg}</span>
          </div>
        </div>
        <div class="db-form-f">
          <Show when={c0}>{(c) => <button type="button" class="db-btn db-ghost" onClick={() => props.onRemove(c())}>Remove</button>}</Show>
          <span class="db-grow muted">Saved to <code>.dev/databases.json</code></span>
          <button type="button" class="db-btn" onClick={() => props.onDone()}>Cancel</button>
          <button type="submit" class="db-btn db-pri" disabled={busy() || sqliteRemote()}>{c0 ? "Save" : "Save & open"}</button>
        </div>
      </form>
    </div>
  );
}

// ── the window ──────────────────────────────────────────────────────

function Main(props: { project: Project; tab: Tab; conn: DbConn; win: Win | undefined; focused: boolean; onEdit: () => void }): JSX.Element {
  const id = props.tab.id;
  const w = () => props.win;
  const [q, setQ] = createSignal("");
  const groups = createMemo(() => {
    const f = q().toLowerCase();
    return (w()?.groups ?? []).map((g) => ({ ...g, objects: g.objects.filter((o) => o.name.toLowerCase().includes(f)) })).filter((g) => g.objects.length);
  });
  const onKey = (e: KeyboardEvent) => {
    if (props.focused && dbViewKey(id, e)) e.preventDefault();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  const objLabel = () => (w()?.obj ? (props.conn.kind === "postgres" && w()!.obj!.group !== "public" ? `${w()!.obj!.group}.` : "") + w()!.obj!.name : "");

  return (
    <Show when={w()?.status !== "error"} fallback={
      <div class="db-start">
        <div class="db-start-in">
          <h3>Couldn't open {props.conn.name}</h3>
          <pre class="db-err">{w()?.error}</pre>
          <div class="db-row">
            <button class="db-btn db-pri" onClick={() => openSession(props.project, props.tab, true)}><Icon name="refresh-cw" size={13} />Retry</button>
            <button class="db-btn" onClick={props.onEdit}><Icon name="settings" size={13} />Edit connection</button>
            <button class="db-btn db-ghost" onClick={() => setTabDb(props.project.id, id, undefined)}>Other connections</button>
          </div>
        </div>
      </div>
    }>
      <div class="db-main">
        <div class="db-tree">
          <div class="db-tree-h">
            <div class="db-search"><Icon name="search" size={12} /><input placeholder={props.conn.kind === "mongo" ? "Filter collections" : "Filter tables"} value={q()} onInput={(e) => setQ(e.currentTarget.value)} /></div>
            <button class="db-ib" title="Reload the schema" onClick={() => loadSchema(id)}><Icon name="refresh-cw" size={13} /></button>
          </div>
          <div class="db-tree-b">
            <Show when={w()?.status === "opening"}><div class="db-dim"><Icon name="loader" size={13} class="spin" /> connecting{props.conn.via === "host" && isRemote(props.project) ? ` through ${props.project.host}` : ""}…</div></Show>
            <For each={groups()}>
              {(g) => (
                <>
                  <div class="db-grp" classList={{ shut: w()?.shut.includes(g.name) }} onClick={() => toggleGroup(id, g.name)}>
                    <Icon name="chevron-down" size={12} class="chev" />
                    {props.conn.kind === "mongo" ? "database · " : props.conn.kind === "postgres" ? "schema · " : ""}{g.name}
                    <span class="db-grow" /><span class="db-c">{g.objects.length}</span>
                  </div>
                  <Show when={!w()?.shut.includes(g.name)}>
                    <For each={g.objects}>
                      {(o) => (
                        <div
                          class="db-obj"
                          classList={{ on: w()?.obj?.group === g.name && w()?.obj?.name === o.name, sys: o.kind === "system", view: o.kind === "view" }}
                          onClick={() => openObj(id, { group: g.name, name: o.name, kind: o.kind })}
                        >
                          <Icon name={OBJ_ICON[o.kind]} size={13} />
                          <span class="n">{o.name}</span>
                          <Show when={pendingCount(w()?.pending[`${g.name}.${o.name}`])}><span class="db-dirty" title="Pending Edits" /></Show>
                          <span class="db-c">{o.kind === "view" ? "view" : fmtCount(o.count)}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </div>
          <div class="db-tree-f">
            <span class="live" classList={{ on: w()?.status === "open" }} />
            <span class="db-grow">{w()?.version ?? "…"}{w()?.tunnel ? ` · tunnel :${w()!.tunnel}` : ""}</span>
            <Show when={props.conn.readOnly}><span class="db-pill ro" title="Read-only Connection"><Icon name="lock" size={10} />read-only</span></Show>
            <Show when={props.conn.tag === "prod"}><span class="db-pill prod">prod</span></Show>
            <button class="db-ib" title="Edit connection" onClick={props.onEdit}><Icon name="settings" size={13} /></button>
            <button class="db-ib" title="Other connections" onClick={() => setTabDb(props.project.id, id, undefined)}><Icon name="list" size={13} /></button>
          </div>
        </div>
        <div class="db-pane">
          <div class="db-ph">
            <span class={`db-kind ${props.conn.kind}`}>{KIND_LABEL[props.conn.kind]}</span>
            <span class="db-obname">{objLabel()}</span>
            <div class="db-views">
              <For each={[["data", "Data", "1"], ["query", "Query", "2"], ["structure", "Structure", "3"]] as const}>
                {([v, label, k]) => <button classList={{ on: w()?.view === v }} onClick={() => setView(id, v)}>{label} <kbd>{k}</kbd></button>}
              </For>
            </div>
            <span class="db-grow" />
            <Show when={w()?.view === "data"}><DataTools tabId={id} conn={props.conn} win={w()} /></Show>
          </div>
          <Show when={w()?.view === "data"}><DataView project={props.project} tab={props.tab} conn={props.conn} win={w()} focused={props.focused} /></Show>
          <Show when={w()?.view === "query"}><QueryView tabId={id} conn={props.conn} win={w()} focused={props.focused} /></Show>
          <Show when={w()?.view === "structure"}><StructureView conn={props.conn} win={w()} /></Show>
        </div>
        <Show when={w()?.review}>{(r) => <Review project={props.project} tabId={id} conn={props.conn} review={r()} />}</Show>
      </div>
    </Show>
  );
}

/** Why the shown table can't be edited, or nothing. */
function lockReason(conn: DbConn, win: Win | undefined): string | null {
  if (conn.readOnly) return "Read-only Connection";
  const o = win?.obj;
  if (!o) return "";
  if (o.kind === "view") return "Views can't be edited";
  if (o.kind === "system") return "System table";
  const s = structOf(win);
  if (s && !s.key.length) return "No primary key";
  if (s && win?.page && !s.key.every((k) => win.page!.columns.some((c) => c.name === k))) return "No primary key";
  return s ? null : "";
}

function DataTools(props: { tabId: string; conn: DbConn; win: Win | undefined }): JSX.Element {
  const locked = () => lockReason(props.conn, props.win) !== null;
  return (
    <div class="db-row">
      <button class="db-btn" disabled={locked()} onClick={() => addRow(props.tabId)} title="New row (n)">
        <Icon name="plus" size={13} />{props.conn.kind === "mongo" ? "Document" : "Row"}
      </button>
      <button class="db-ib" title="Reload (r)" onClick={() => loadPage(props.tabId)}><Icon name="refresh-cw" size={13} /></button>
    </div>
  );
}

// ── Data ────────────────────────────────────────────────────────────

/** One row of the grid: a new row, or a loaded one with its Pending Edits laid over. */
type GridRow = { added?: number; page?: number; values: Record<string, Cell>; key: string; deleted: boolean; changed: Set<string> };

function DataView(props: { project: Project; tab: Tab; conn: DbConn; win: Win | undefined; focused: boolean }): JSX.Element {
  const id = props.tab.id;
  const w = () => props.win;
  const cols = () => w()?.page?.columns ?? [];
  const struct = () => structOf(w());
  const info = (name: string) => struct()?.columns.find((c) => c.name === name);
  const key = () => struct()?.key ?? [];
  const lock = () => lockReason(props.conn, w());
  const [editing, setEditing] = createSignal<{ r: number; c: number } | null>(null);
  const [filterText, setFilterText] = createSignal(w()?.filter ?? "");
  createEffect(on(() => w()?.obj?.name, () => setFilterText(w()?.filter ?? "")));
  let gridEl!: HTMLDivElement;
  let filterEl!: HTMLInputElement;

  const rows = createMemo<GridRow[]>(() => {
    const page = w()?.page;
    const pend = pendingOf(w());
    if (!page) return [];
    const added = (pend?.added ?? []).map((v, i) => ({ added: i, values: v, key: `+${i}`, deleted: false, changed: new Set(Object.keys(v)) }));
    const loaded = page.rows.map((r, i) => {
      const values = rowObj(page.columns, r);
      const k = rowKey(key(), values);
      const set = pend?.edits[k]?.set ?? {};
      return { page: i, values: { ...values, ...set }, key: k, deleted: !!pend?.deleted[k], changed: new Set(Object.keys(set)) };
    });
    return [...added, ...loaded];
  });

  const at = (r: GridRow) => (r.added !== undefined ? { added: r.added } : { page: r.page! });
  const sel = () => w()?.sel ?? { r: 0, c: 0 };
  const cellEl = (r: number, c: number) => gridEl?.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`);

  const canEdit = (r: GridRow, col: string): string | null => {
    if (lock() !== null) return lock() || "loading";
    if (r.deleted) return "deleted row";
    if (r.added === undefined && key().includes(col)) return "the key finds the row: change it in the Query view";
    if (isOpaque(r.values[col] ?? null)) return "this value is cut or binary";
    return null;
  };
  const startEdit = () => {
    const r = rows()[sel().r];
    const col = cols()[sel().c]?.name;
    if (!r || !col) return;
    const why = canEdit(r, col);
    if (why) return void flash(why);
    setEditing({ r: sel().r, c: sel().c });
  };
  const commit = (text: string) => {
    const e = editing();
    setEditing(null);
    if (!e) return;
    const r = rows()[e.r];
    const col = cols()[e.c];
    if (!r || !col) return;
    const was = r.values[col.name] ?? null;
    const ci = info(col.name);
    setCell(id, at(r), col.name, parseInput(props.conn.kind, text, was, ci?.type ?? col.type, ci?.nullable ?? true));
    gridEl?.focus();
  };
  const move = (dr: number, dc: number) => {
    const r = Math.max(0, Math.min(rows().length - 1, sel().r + dr));
    const c = Math.max(0, Math.min(cols().length - 1, sel().c + dc));
    setSelCell(id, r, c);
    requestAnimationFrame(() => cellEl(r, c)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };

  const onKey = (e: KeyboardEvent) => {
    if (!props.focused || w()?.view !== "data" || w()?.review || editing()) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t?.closest("input, textarea, select, .cm-editor");
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (pendingCount(pendingOf(w()))) review(props.project, id);
      else flash("no Pending Edits");
      return;
    }
    if (typing || e.altKey) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); return undo(id); }
    if (mod) return;
    const keys: Record<string, () => void> = {
      ArrowUp: () => move(-1, 0), ArrowDown: () => move(1, 0), ArrowLeft: () => move(0, -1), ArrowRight: () => move(0, 1),
      Home: () => move(0, -1e6), End: () => move(0, 1e6), PageUp: () => move(-20, 0), PageDown: () => move(20, 0),
      Enter: startEdit, F2: startEdit,
      Delete: () => { const r = rows()[sel().r]; if (lock() !== null) flash(lock() || "loading"); else if (r) toggleDelete(id, at(r)); },
      n: () => (lock() === null ? addRow(id) : flash(lock() || "loading")),
      r: () => loadPage(id),
      "/": () => filterEl?.focus(),
      "]": () => turnPage(id, 1),
      "[": () => turnPage(id, -1),
      " ": () => openNested(),
    };
    const k = keys[e.key];
    if (k) { e.preventDefault(); k(); }
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));
  createEffect(() => {
    if (props.focused && w()?.view === "data" && !editing()) requestAnimationFrame(() => { if (!document.activeElement?.closest(".db-filter")) gridEl?.focus({ preventScroll: true }); });
  });

  const openNested = () => {
    const r = rows()[sel().r];
    const col = cols()[sel().c]?.name;
    const v = r && col ? r.values[col] ?? null : null;
    if (r && col && isNested(v)) setDoc(id, w()?.doc?.col === col && w()?.doc?.v === v ? undefined : { col, v });
  };

  const pend = () => pendingOf(w());
  const count = () => pendingCount(pend());
  const p = () => w()?.page;
  const from = () => (w()?.offset ?? 0) + 1;

  return (
    <>
      <div class="db-filter">
        <span class="kw">{props.conn.kind === "mongo" ? "filter" : "WHERE"}</span>
        <input
          ref={filterEl}
          class="mono"
          value={filterText()}
          placeholder={props.conn.kind === "mongo" ? "a filter document, e.g. { \"status\": \"open\" } · Enter applies, Esc clears" : "a WHERE expression, e.g. status = 'open' · Enter applies, Esc clears"}
          onInput={(e) => setFilterText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); setFilter(id, filterText()); gridEl.focus(); }
            if (e.key === "Escape") { e.preventDefault(); setFilterText(""); setFilter(id, ""); gridEl.focus(); }
          }}
        />
        <Show when={lock()}>
          {(why) => <span class="db-pill ro"><Icon name="lock" size={10} />{why()}</span>}
        </Show>
        <Show when={lock() === null && key()[0] === "rowid"}>
          <span class="db-pill ro" title="No primary key: rows are found by rowid"><Icon name="key-round" size={10} />rowid</span>
        </Show>
      </div>
      <div class="db-split">
        <div class="db-grid" ref={gridEl} tabindex="0">
          <Show when={w()?.pageError}>{(err) => <pre class="db-err">{err()}</pre>}</Show>
          <table>
            <thead>
              <tr>
                <th class="rn">#</th>
                <For each={cols()}>
                  {(c) => {
                    const ci = () => info(c.name);
                    return (
                      <th onClick={() => toggleSort(id, c.name)} title={ci()?.default ? `default ${ci()!.default}` : undefined}>
                        <div class="h">
                          <Show when={key().includes(c.name)}><Icon name="key-round" size={11} class="pk" /></Show>
                          {c.name}
                          <span class="t">{ci()?.type ?? c.type}</span>
                          <Show when={w()?.sort?.col === c.name}><span class="sort">{w()!.sort!.desc ? "▼" : "▲"}</span></Show>
                        </div>
                      </th>
                    );
                  }}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(r, ri) => (
                  <tr classList={{ "r-add": r.added !== undefined, "r-del": r.deleted }}>
                    <td class="rn">{r.added !== undefined ? "+" : r.deleted ? "−" : from() + r.page!}</td>
                    <For each={cols()}>
                      {(c, ci) => {
                        const v = () => r.values[c.name] ?? null;
                        const isEd = () => editing()?.r === ri() && editing()?.c === ci();
                        const num = () => typeof v() === "number" || /^(int|bigint|smallint|numeric|real|double|float|decimal|integer|long|double precision|money|oid)/i.test(info(c.name)?.type ?? c.type);
                        return (
                          <td
                            data-r={ri()}
                            data-c={ci()}
                            classList={{
                              sel: sel().r === ri() && sel().c === ci(),
                              mod: r.added === undefined && r.changed.has(c.name),
                              nul: v() === null,
                              num: num() && v() !== null,
                              editing: isEd(),
                            }}
                            title={r.added === undefined && r.changed.has(c.name) ? `was: ${cellText(rowObj(cols(), w()!.page!.rows[r.page!])[c.name] ?? null)}` : undefined}
                            onClick={(e) => {
                              setSelCell(id, ri(), ci());
                              if ((e.target as Element).closest(".chip")) openNested();
                            }}
                            onDblClick={() => { setSelCell(id, ri(), ci()); startEdit(); }}
                          >
                            <Show when={isEd()} fallback={
                              <Show when={isNested(v())} fallback={<>{v() === null ? (r.added !== undefined ? "" : "NULL") : cellText(v())}</>}>
                                <span class="chip">{Array.isArray(v()) ? `[…] ${(v() as unknown[]).length}` : `{…} ${Object.keys(v() as object).length}`}</span>{" "}
                                <span class="muted">{JSON.stringify(v()).slice(0, 60)}</span>
                              </Show>
                            }>
                              <CellInput value={editText(v())} placeholder={info(c.name)?.nullable === false ? "" : "NULL"} onDone={(t) => (t === null ? (setEditing(null), gridEl.focus()) : commit(t))}
                                onTab={(t) => { commit(t); move(0, 1); startEdit(); }} />
                            </Show>
                          </td>
                        );
                      }}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={p() && !p()!.rows.length && !(pend()?.added.length)}>
            <div class="db-dim center">{w()?.filter ? "No rows match the filter." : "Empty."}</div>
          </Show>
        </div>
        <Show when={w()?.doc}>
          {(d) => (
            <div class="db-doc">
              <div class="db-doc-h"><Icon name="braces" size={13} /><b>{d().col}</b><span class="db-grow" /><button class="db-ib" onClick={() => setDoc(id, undefined)}><Icon name="x" size={13} /></button></div>
              <pre>{JSON.stringify(d().v, null, 2)}</pre>
            </div>
          )}
        </Show>
      </div>
      <Show when={count() || w()?.applyError}>
        <div class="db-pending" classList={{ bad: !!w()?.applyError }}>
          <Show when={w()?.applyError} fallback={
            <>
              <b>{count()} pending</b>
              <span class="cnt">
                <span><i class="sq mod" />{Object.values(pend()?.edits ?? {}).reduce((n, e) => n + Object.keys(e.set).length, 0)} changed</span>
                <span><i class="sq add" />{pend()?.added.length ?? 0} new</span>
                <span><i class="sq del" />{Object.keys(pend()?.deleted ?? {}).length} deleted</span>
              </span>
            </>
          }>
            {(err) => <span class="db-grow mono">{err()}</span>}
          </Show>
          <span class="db-grow" />
          <button class="db-btn db-ghost" onClick={() => undo(id)}>Undo <kbd>Ctrl+Z</kbd></button>
          <button class="db-btn" onClick={() => discard(id)}>Discard</button>
          <button class="db-btn" classList={{ "db-pri": props.conn.tag !== "prod", "db-danger": props.conn.tag === "prod" }} disabled={!count()} onClick={() => review(props.project, id)}>
            Review &amp; apply <kbd>Ctrl+S</kbd>
          </button>
        </div>
      </Show>
      <div class="db-status">
        <Show when={p()} fallback={<span>{w()?.loading ? "loading…" : ""}</span>}>
          <span>{p()!.total != null ? `${p()!.total!.toLocaleString()} ${props.conn.kind === "mongo" ? "documents" : "rows"}${w()?.filter ? " matching" : ""}` : `${p()!.rows.length}${p()!.more ? "+" : ""} ${w()?.filter ? "matching" : "rows"}`}</span>
          <span>·</span>
          <span>showing {p()!.rows.length ? from() : 0}–{(w()?.offset ?? 0) + p()!.rows.length}</span>
          <Show when={w()?.loading}><span>· loading…</span></Show>
        </Show>
        <span class="db-grow" />
        <span class="mono">{cols()[sel().c]?.name}</span>
        <button class="db-ib" title="Previous page ([)" disabled={!w()?.offset} onClick={() => turnPage(id, -1)}><Icon name="chevron-left" size={13} /></button>
        <span>page {Math.floor((w()?.offset ?? 0) / 500) + 1}{p()?.total ? ` / ${Math.max(1, Math.ceil(p()!.total! / 500)).toLocaleString()}` : ""}</span>
        <button class="db-ib" title="Next page (])" disabled={!p()?.more} onClick={() => turnPage(id, 1)}><Icon name="chevron-right" size={13} /></button>
      </div>
    </>
  );
}

function CellInput(props: { value: string; placeholder: string; onDone: (text: string | null) => void; onTab: (text: string) => void }): JSX.Element {
  let el!: HTMLInputElement;
  let done = false;
  const finish = (t: string | null) => { if (!done) { done = true; props.onDone(t); } };
  onMount(() => { el.focus(); el.select(); });
  return (
    <input
      ref={el}
      value={props.value}
      placeholder={props.placeholder}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(el.value); }
        if (e.key === "Escape") { e.preventDefault(); finish(null); }
        if (e.key === "Tab") { e.preventDefault(); done = true; props.onTab(el.value); }
      }}
      onBlur={() => finish(el.value)}
    />
  );
}

// ── Review ──────────────────────────────────────────────────────────

function Review(props: { project: Project; tabId: string; conn: DbConn; review: NonNullable<Win["review"]> }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  let goEl!: HTMLButtonElement;
  onMount(() => goEl.focus());
  const prod = () => props.conn.tag === "prod";
  const go = async () => { setBusy(true); await apply(props.tabId); setBusy(false); };
  return (
    <div class="db-scrim" onClick={(e) => e.target === e.currentTarget && closeReview(props.tabId)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeReview(props.tabId); } }}>
      <div class="db-dlg">
        <div class="db-dlg-h"><Icon name="check" size={14} /><b class="db-grow">Review {props.review.ops.length} {props.review.ops.length === 1 ? "change" : "changes"}</b><button class="db-ib" onClick={() => closeReview(props.tabId)}><Icon name="x" size={13} /></button></div>
        <div class="db-dlg-b">
          <Show when={prod()}>
            <div class="db-prodwarn"><Icon name="triangle-alert" size={14} /><div><b>This Connection is tagged prod.</b> These run against {props.conn.name}{props.conn.kind === "mongo" ? ", in order." : " in one transaction."}</div></div>
          </Show>
          <pre class="db-stmts">{props.review.text.join("\n")}</pre>
          <div class="muted small">
            {props.conn.kind === "mongo"
              ? "Each update also matches the old values. If a document changed since it was loaded, it stops there; the changes before it stay written (a transaction needs a replica set)."
              : "Each UPDATE also matches the cell's old value. If a row changed since it was loaded, nothing is written."}
          </div>
        </div>
        <div class="db-dlg-f">
          <button class="db-btn db-ghost" onClick={() => { navigator.clipboard?.writeText(props.review.text.join("\n")); flash("copied"); }}><Icon name="copy" size={13} />Copy</button>
          <span class="db-grow" />
          <button class="db-btn" onClick={() => closeReview(props.tabId)}>Cancel</button>
          <button ref={goEl} class="db-btn" classList={{ "db-pri": !prod(), "db-danger": prod() }} disabled={busy()} onClick={go}>{prod() ? "Apply to prod" : "Apply"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Query ───────────────────────────────────────────────────────────

const STARTER: Record<DbKind, (obj?: string) => string> = {
  postgres: (o) => `-- Ctrl+Enter runs, Esc cancels\nSELECT *\n  FROM ${o ?? "users"}\n LIMIT 100;\n`,
  sqlite: (o) => `-- Ctrl+Enter runs, Esc cancels\nSELECT *\n  FROM ${o ?? "sqlite_master"}\n LIMIT 100;\n`,
  mongo: (o) => `{\n  "find": "${o ?? "collection"}",\n  "filter": {},\n  "limit": 50\n}\n`,
};

function QueryView(props: { tabId: string; conn: DbConn; win: Win | undefined; focused: boolean }): JSX.Element {
  const id = props.tabId;
  const w = () => props.win;
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const lang = new Compartment();
  const qname = (o?: { group: string; name: string }) =>
    !o ? undefined : props.conn.kind === "postgres" ? (o.group === "public" ? o.name : `${o.group}.${o.name}`) : o.name;

  const language = () => {
    if (props.conn.kind === "mongo") return json();
    const schema: Record<string, string[]> = {};
    for (const g of w()?.groups ?? []) for (const o of g.objects) {
      const s = w()?.structs[`${g.name}.${o.name}`];
      schema[props.conn.kind === "postgres" && g.name !== "public" ? `${g.name}.${o.name}` : o.name] = s?.columns.map((c) => c.name) ?? [];
    }
    return sql({ dialect: props.conn.kind === "postgres" ? PostgreSQL : SQLite, schema, upperCaseKeywords: true });
  };

  const run = async () => {
    if (!view) return;
    const sel = view.state.selection.main;
    const text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
    if (props.conn.tag === "prod" && writes(props.conn.kind, text) && !(await ask(`${props.conn.name} is tagged prod, and this changes data.\n\nRun it?`))) return;
    runQuery(id, text);
  };

  onMount(() => {
    const doc = w()?.query || STARTER[props.conn.kind](qname(w()?.obj));
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), bracketMatching(), closeBrackets(), autocompletion({ activateOnTyping: true }),
          syntaxHighlighting(highlight), theme, lang.of(language()),
          keymap.of([
            { key: "Mod-Enter", run: () => (run(), true), preventDefault: true },
            { key: "Escape", run: () => (w()?.running ? (cancelQuery(id), true) : false) },
            ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) setQuery(id, u.state.doc.toString()); }),
        ],
      }),
    });
    if (!w()?.query) setQuery(id, doc);
    if (props.focused) view.focus();
  });
  onCleanup(() => view?.destroy());
  createEffect(on(() => [w()?.groups, Object.keys(w()?.structs ?? {}).length], () => view?.dispatch({ effects: lang.reconfigure(language()) }), { defer: true }));
  createEffect(() => { if (props.focused) requestAnimationFrame(() => view?.focus()); });

  const sets = () => w()?.results ?? [];
  const cur = () => sets()[w()?.resTab ?? 0];
  return (
    <div class="db-qv">
      <div class="db-ed" ref={host} />
      <div class="db-qbar">
        <button class="db-btn db-pri" disabled={w()?.running} onClick={run}><Icon name="play" size={12} />Run <kbd>Ctrl+Enter</kbd></button>
        <Show when={w()?.running}>
          <button class="db-btn" onClick={() => cancelQuery(id)}>Cancel <kbd>Esc</kbd></button>
          <span class="muted"><Icon name="loader" size={12} class="spin" /> running…</span>
        </Show>
        <Show when={!w()?.running && cur()}>
          {(s) => <span class="muted">{s().affected != null && !s().columns.length ? `${s().affected} affected` : `${s().rows.length}${s().more ? "+" : ""} rows`} · {s().ms} ms</span>}
        </Show>
        <span class="db-grow" />
        <Show when={sets().length > 1}>
          <div class="db-views">
            <For each={sets()}>{(_, i) => <button classList={{ on: (w()?.resTab ?? 0) === i() }} onClick={() => setResTab(id, i())}>{i() + 1}</button>}</For>
          </div>
        </Show>
        <span class="muted small">{props.conn.kind === "mongo" ? "a runCommand document · EJSON" : props.conn.kind === "postgres" ? "PostgreSQL · timeout 30 s" : "SQLite"} · max 500 rows</span>
      </div>
      <div class="db-res">
        <Show when={w()?.runError}>{(e) => <pre class="db-err">{e()}</pre>}</Show>
        <Show when={!w()?.runError && cur()} fallback={<Show when={!w()?.runError}><div class="db-dim center">Results show here. Run part of the text by selecting it.</div></Show>}>
          {(s) => <ResultGrid set={s()} />}
        </Show>
      </div>
    </div>
  );
}

function ResultGrid(props: { set: ResultSet }): JSX.Element {
  return (
    <Show when={props.set.columns.length} fallback={<div class="db-msg ok mono">{props.set.affected ?? 0} rows affected</div>}>
      <div class="db-grid">
        <table>
          <thead><tr><th class="rn">#</th><For each={props.set.columns}>{(c) => <th><div class="h">{c.name} <span class="t">{c.type}</span></div></th>}</For></tr></thead>
          <tbody>
            <For each={props.set.rows}>
              {(r, i) => (
                <tr>
                  <td class="rn">{i() + 1}</td>
                  <For each={r}>{(v) => <td classList={{ nul: v === null, num: typeof v === "number" }}>{cellText(v)}</td>}</For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={props.set.more}><div class="db-dim center">Stopped at 500 rows.</div></Show>
      </div>
    </Show>
  );
}

// ── Structure ───────────────────────────────────────────────────────

function StructureView(props: { conn: DbConn; win: Win | undefined }): JSX.Element {
  const s = () => structOf(props.win);
  const mongo = () => props.conn.kind === "mongo";
  return (
    <div class="db-sv">
      <Show when={s()} fallback={<div class="db-dim">loading…</div>}>
        {(st) => (
          <>
            <h4>{mongo() ? "Fields (sampled)" : "Columns"} · {st().columns.length}</h4>
            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Null</th><th>Key</th><th>Default</th></tr></thead>
              <tbody>
                <For each={st().columns}>
                  {(c) => (
                    <tr>
                      <td class="mono">{c.name}</td>
                      <td class="mono muted">{c.type}</td>
                      <td>{c.pk ? "" : c.nullable ? "yes" : "no"}</td>
                      <td>{st().key.includes(c.name) ? <span class="pk">{c.name === "rowid" ? "rowid" : "PK"}</span> : ""}</td>
                      <td class="mono muted">{c.default ?? ""}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <h4>Indexes · {st().indexes.length}</h4>
            <Show when={st().indexes.length} fallback={<div class="muted">None</div>}>
              <table><tbody><For each={st().indexes}>{(i) => <tr><td class="mono">{i.name}</td><td class="mono muted">{i.def}</td></tr>}</For></tbody></table>
            </Show>
            <Show when={!mongo()}>
              <h4>Foreign keys · {st().fks.length}</h4>
              <Show when={st().fks.length} fallback={<div class="muted">None</div>}>
                <table><tbody><For each={st().fks}>{(f) => <tr><td class="mono">{f.name}</td><td class="mono muted">{f.def}</td></tr>}</For></tbody></table>
              </Show>
            </Show>
            <h4 class="db-row">{mongo() ? "Shape" : "Definition"}<span class="db-grow" /><button class="db-btn db-ghost" onClick={() => { navigator.clipboard?.writeText(st().ddl); flash("copied"); }}><Icon name="copy" size={12} />Copy</button></h4>
            <pre class="db-ddl">{st().ddl}</pre>
          </>
        )}
      </Show>
    </div>
  );
}

/** Plain 1 / 2 / 3 switch views while the window is focused and not typing. */
function dbViewKey(tabId: string, e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (e.ctrlKey || e.metaKey || e.altKey || t?.closest("input, textarea, select, .cm-editor")) return false;
  const v = ({ "1": "data", "2": "query", "3": "structure" } as const)[e.key as "1"];
  if (!v || !wins[tabId] || wins[tabId].review) return false;
  setView(tabId, v);
  return true;
}
