import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { definePluginApp, experimental_useAppPanel, useBbNavigate, useRpc, useSdk, useSettings, type JsonValue, type PluginFileOpenerProps, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Item, Scope, Snapshot } from "./src/contracts";
import type { Anchor, Comment } from "./src/review-contract";
import { describeError, plural, strings, type Strings } from "./src/i18n";
import { useLive } from "./ui/use-live";
import { itemExists, planningProgress } from "./src/progress";
import { MarkdownReview } from "./ui/markdown-review";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./app.css";

const textareaClass = "min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm";
function Notice({ children }: { children: ReactNode }) { return <p className="rounded border border-dashed border-border p-3 text-sm text-muted-foreground" role="status">{children}</p>; }
function ErrorBox({ error, t }: { error: unknown; t: Strings }) {
  if (!error) return null;
  const message = describeError(t, error);
  return <div className="rounded border border-destructive p-3 text-sm" role="alert"><p>{message.label}</p><details><summary>{t.diagnostic}</summary><pre className="whitespace-pre-wrap break-all text-xs">{message.detail}</pre></details></div>;
}
function useAction() {
  const [error, setError] = useState<unknown>(); const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true); setError(undefined);
    try { await action(); } catch (e) { setError(e); } finally { setPending(false); }
  };
  return { error, pending, run };
}
function useThreadScope(threadId: string) {
  const sdk = useSdk();
  const thread = useLive(useCallback(() => sdk.threads.get({ threadId }), [sdk, threadId]), false, `thread:${threadId}`);
  const projectId = thread.data?.projectId; const environmentId = thread.data?.environmentId;
  const scope = useMemo(() => projectId && environmentId ? { projectId, environmentId } : null, [projectId, environmentId]);
  return { thread, scope };
}
// OpenSpec's lastModified is the newest file mtime in the change folder: the change being worked on now.
const latestChange = (changes: Snapshot["changes"] = []) => changes.reduce<Snapshot["changes"][number] | undefined>((a, c) => !a || Date.parse(c.lastModified) > Date.parse(a.lastModified) ? c : a, undefined);
function Workspace({ threadId, path, change }: { threadId: string; path?: string; change?: string }) {
  const { values } = useSettings(); const t = strings(values?.language);
  const { thread, scope } = useThreadScope(threadId);
  return <main className="openspec-workspace h-full overflow-y-auto p-3">
    <div className="space-y-4">
      <ErrorBox error={thread.error} t={t} />
      {thread.loading ? <Notice>{t.loading}</Notice> : scope
        ? path ? <FileReview scope={scope} path={path} threadId={threadId} t={t} /> : <ScopedWorkspace key={scope.environmentId} scope={scope} threadId={threadId} change={change} t={t} />
        : <Notice>{t.noThread}</Notice>}
    </div>
  </main>;
}
function ScopedWorkspace({ scope, threadId, change, t }: { scope: Scope; threadId: string; change?: string; t: Strings }) {
  const rpc = useRpc<typeof rpcContract>();
  const [watchError, setWatchError] = useState<unknown>();
  useEffect(() => {
    const token = crypto.randomUUID(); let active = true; let busy = false;
    const stop = () => rpc.call("watch", { ...scope, token, active: false }).catch(() => { /* Host leases expire after 30s if the disconnected client cannot dispose. */ });
    const renew = async () => {
      if (busy || !active) return; busy = true;
      try { await rpc.call("watch", { ...scope, token, active: true }); if (active) setWatchError(undefined); else await stop(); }
      catch (e) { if (active) setWatchError(e); }
      finally { busy = false; }
    };
    void renew(); const timer = setInterval(() => { void renew(); }, 10_000);
    return () => { active = false; clearInterval(timer); void stop(); };
  }, [rpc, scope]);
  const snapshot = useLive(useCallback(() => rpc.call("snapshot", scope), [rpc, scope]), true, `snapshot:${JSON.stringify(scope)}`);
  const [selected, setSelected] = useState<Item | null>(change ? { kind: "change", id: change } : null);
  const [search, setSearch] = useState("");
  const [showList, setShowList] = useState(!change);
  // Document actions render into the sticky toolbar so they stay visible while scrolling.
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const layout = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!selected) return;
    const target = showList
      ? (layout.current?.querySelector<HTMLElement>('.openspec-list button[aria-pressed="true"]') ?? layout.current?.querySelector<HTMLElement>(".openspec-list input"))
      : layout.current?.querySelector<HTMLElement>(".openspec-detail h2");
    target?.focus();
  }, [showList, selected]);
  // Choosing from the list always opens the card, even for the already selected item.
  const [opened, setOpened] = useState(0);
  const choose = (item: Item) => { setSelected(item); setShowList(false); setOpened(n => n + 1); };
  const latest = latestChange(snapshot.data?.changes);
  const matches = (id: string) => id.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const groups = snapshot.data ? [
    { key: "spec" as const, name: t.specs, rows: snapshot.data.specs.map(s => ({ id: s.id, extra: `${s.requirementCount}` })) },
    { key: "change" as const, name: t.changes, rows: snapshot.data.changes.map(c => ({ id: c.name, extra: c.totalTasks ? `${c.completedTasks}/${c.totalTasks}` : t.noTasks })) },
    { key: "archive" as const, name: t.archive, rows: snapshot.data.archive.map(a => ({ id: a.id, extra: "" })) },
  ] : [];
  return <div className="space-y-3">
    <div className="openspec-toolbar flex flex-wrap items-start gap-2">
      {selected && !showList && <Button variant="ghost" size="sm" onClick={() => setShowList(true)}>‹ {{ spec: t.specs, change: t.changes, archive: t.archive }[selected.kind]}</Button>}
      {latest && !(selected?.kind === "change" && selected.id === latest.name && !showList) && <Button variant="outline" size="sm" className="max-w-56" aria-label={`${t.latest}: ${latest.name}`} onClick={() => choose({ kind: "change", id: latest.name })}><span className="truncate">{t.latest}: {latest.name}</span></Button>}
      <div ref={setToolbar} className="ml-auto flex flex-wrap items-center gap-2" />
    </div>
    <ErrorBox error={snapshot.error || watchError} t={t} />
    {snapshot.stale && snapshot.data && <Notice>{t.stale}</Notice>}
    {snapshot.loading && !snapshot.data && <Notice>{t.loading}</Notice>}
    <div ref={layout} className="openspec-layout min-w-0">
      <aside className={`openspec-list ${showList ? "" : "openspec-secondary"} min-w-0 space-y-4`}>
        <Input aria-label={t.search} placeholder={t.search} value={search} onChange={e => setSearch(e.target.value)} />
        {groups.map(group => <section key={group.key} className="space-y-2"><h2 className="font-semibold">{group.name} <span className="text-muted-foreground">{group.rows.length}</span></h2>
          {!group.rows.filter(row => matches(row.id)).length && <Notice>{t.empty}</Notice>}
          {group.rows.filter(row => matches(row.id)).map(row => <ItemButton key={row.id} item={{ kind: group.key, id: row.id }} extra={row.extra} selected={selected} onChoose={choose} />)}
        </section>)}
      </aside>
      <div className={`openspec-detail ${showList ? "openspec-secondary" : ""} min-w-0 space-y-4`}>
        {selected ? <ItemDetail key={`${selected.kind}/${selected.id}/${opened}`} scope={scope} item={selected} snapshot={snapshot.data} threadId={threadId} toolbar={showList ? null : toolbar} t={t} />
          : <Notice>{t.documents}</Notice>}
      </div>
    </div>
  </div>;
}
function ItemButton({ item, extra, selected, onChoose }: { item: Item; extra: string; selected: Item | null; onChoose: (i: Item) => void }) {
  const active = item.id === selected?.id && item.kind === selected.kind;
  return <button type="button" aria-pressed={active} className={`flex w-full flex-col gap-1 rounded border border-border p-2 text-left text-sm ${active ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`} onClick={() => onChoose(item)}><span className="break-all">{item.id}</span>{extra && <span className="text-xs text-muted-foreground">{extra}</span>}</button>;
}
const sectionLabel = "text-xs font-medium text-muted-foreground";
// Paths wrap after "/" first, never mid-name unless a segment alone overflows.
const slashBreaks = (path: string) => path.split("/").map((seg, i) => <span key={i}>{i > 0 && <>/<wbr /></>}{seg}</span>);
const statusGlyph = { done: "✓", ready: "○", blocked: "–", skipped: "⌀" } as const;
const deltaOps = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"] as const;
function itemBase(item: Item) {
  return item.kind === "spec" ? `openspec/specs/${item.id}/` : item.kind === "change" ? `openspec/changes/${item.id}/` : `openspec/changes/archive/${item.id}/`;
}
function ItemDetail({ scope, item, snapshot, threadId, toolbar, t }: { scope: Scope; item: Item; snapshot?: Snapshot; threadId: string; toolbar: HTMLElement | null; t: Strings }) {
  const rpc = useRpc<typeof rpcContract>();
  const detail = useLive(useCallback(() => rpc.call("detail", { ...scope, item }), [rpc, scope, item]), true, `detail:${JSON.stringify([scope, item])}`);
  const pathsKey = detail.data?.paths.join("\n") ?? "";
  const stats = useLive(useCallback(() => pathsKey ? rpc.call("reviewStats", { ...scope, paths: pathsKey.split("\n") }) : Promise.resolve([]), [rpc, scope, pathsKey]), false, `stats:${JSON.stringify([scope, pathsKey])}`);
  const [path, setPath] = useState("");
  const heading = useRef<HTMLHeadingElement>(null); const switched = useRef(false);
  // The workspace focuses the first view; card ↔ document switches are focused here.
  useEffect(() => { if (switched.current) heading.current?.focus(); switched.current = true; }, [path]);
  const base = itemBase(item); const data = detail.data;
  const short = (p: string) => p.startsWith(base) ? p.slice(base.length) : p;
  if (path) return <section className="min-w-0 space-y-4">
    <Button variant="ghost" size="sm" onClick={() => setPath("")}>‹ {t.backTo} {item.id}</Button>
    <h2 ref={heading} tabIndex={-1} className="break-all font-mono text-sm font-medium">{short(path)}</h2>
    <ReviewDocument key={path} scope={scope} path={path} threadId={threadId} toolbar={toolbar} t={t} />
  </section>;
  const planning = data?.status ? planningProgress(data.status.artifacts) : null;
  const stat = new Map(stats.data?.map(s => [s.path, s]));
  const rows = data?.status
    ? data.status.artifacts.flatMap(a => { const files = data.artifactFiles?.[a.id] ?? []; return files.length ? files.map(p => ({ key: p, path: p, artifact: a })) : [{ key: a.id, path: "", artifact: a }]; })
    : data?.paths.map(p => ({ key: p, path: p, artifact: null })) ?? [];
  const deltaLine = (p: string) => {
    const spec = p.startsWith(`${base}specs/`) && p.endsWith("/spec.md") ? p.slice(base.length + "specs/".length, -"/spec.md".length) : null;
    const ops = data?.deltas?.filter(d => d.spec === spec) ?? [];
    const counts = deltaOps.map(op => [op, ops.filter(d => d.operation === op).length] as const).filter(([, n]) => n);
    return counts.length ? `${t.delta}: ${counts.map(([op, n]) => `${op === "ADDED" ? "+" : ""}${n} ${op}`).join(" · ")}` : "";
  };
  const affected = [...new Set(data?.deltas?.map(d => d.spec))];
  const progress = data?.apply?.progress;
  return <section className="flex min-w-0 flex-col gap-5 text-[13px] leading-snug">
    <header className="flex flex-col gap-1">
      <h2 ref={heading} tabIndex={-1} className="break-all font-mono text-[15px] font-medium">{item.id}</h2>
      {data?.title && data.title !== item.id && <p className="text-foreground/80">{data.title}</p>}
      <p className="flex min-w-0 gap-1 text-xs text-muted-foreground"><span className="truncate" title={base.slice(0, -1)}>{base.slice(0, -1)}</span>{data?.status && <span className="shrink-0 whitespace-nowrap">· {t.schemaLabel} {data.status.schemaName}</span>}</p>
    </header>
    {item.kind === "archive" && <Notice>{t.archiveNote}</Notice>}
    {snapshot && !itemExists(snapshot, item) && <Notice>{t.missing}</Notice>}
    <ErrorBox error={detail.error || stats.error} t={t} />
    {detail.stale && data && <Notice>{t.stale}</Notice>}
    {detail.loading && <Notice>{t.loading}</Notice>}
    {data && <section className="flex flex-col gap-2">
      <h3 className={sectionLabel}>{planning ? `${t.artifacts} · ${planning.complete}/${planning.total} ${t.artifactsReady}` : t.documents}</h3>
      {rows.length ? <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">{rows.map(r => {
        const s = stat.get(r.path);
        const sub = r.path ? deltaLine(r.path) : r.artifact?.status === "blocked" ? `${t.requires}: ${r.artifact.requires.join(", ")}` : r.artifact ? t[r.artifact.status] : "";
        const content = <>
          {r.artifact && <span role="img" aria-label={t[r.artifact.status]} title={t[r.artifact.status]} className="w-4 shrink-0 text-center text-muted-foreground">{statusGlyph[r.artifact.status]}</span>}
          <span className="flex min-w-0 flex-1 flex-col"><span className="font-mono text-xs [overflow-wrap:anywhere]">{slashBreaks(r.path ? short(r.path) : r.artifact?.outputPath ?? "")}</span>{sub && <span className="text-xs text-muted-foreground">{sub}</span>}</span>
          {s?.open ? <span className="shrink-0 text-xs tabular-nums text-orange-700 dark:text-orange-400">{plural(t, s.open, t.commentForms)}</span> : null}
          {s?.sent ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t.sent} {s.sent}</span> : null}
        </>;
        return <li key={r.key}>{r.path
          ? <button type="button" className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted" onClick={() => setPath(r.path)}>{content}</button>
          : <div className="flex items-center gap-2.5 px-3 py-2.5 text-muted-foreground">{content}</div>}</li>;
      })}</ul> : <Notice>{t.noDocuments}</Notice>}
      {planning && <p className="text-[11px] text-muted-foreground">{t.schemaNote}</p>}
    </section>}
    {progress && <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2"><h3 className={sectionLabel}>{t.taskProgress}</h3><span className="text-xs font-medium tabular-nums">{progress.total ? `${progress.complete} ${t.of} ${progress.total}` : t.noTasks}</span></div>
      {progress.total > 0 && <div className="h-1.5 rounded-full bg-muted" role="progressbar" aria-label={t.taskProgress} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.complete}><div className="h-1.5 rounded-full bg-primary" style={{ width: `${progress.complete / progress.total * 100}%` }} /></div>}
      {data?.sections && <ul className="mt-1 flex flex-col gap-1.5">{data.sections.map((s, i) => <li key={i} className="flex items-center gap-2"><span className="min-w-0 flex-1 break-words">{s.title}</span><span className={`text-xs tabular-nums ${s.complete === s.total ? "text-muted-foreground" : "font-medium"}`}>{s.complete}/{s.total}</span></li>)}</ul>}
    </section>}
    {item.kind === "change" && <Mentions scope={scope} changeId={item.id} threadId={threadId} t={t} />}
    {affected.length > 0 && <section className="flex flex-col gap-2"><h3 className={sectionLabel}>{t.affects}</h3>
      <ul className="flex flex-wrap gap-1.5">{affected.map(spec => <li key={spec} className="rounded-md border border-border px-2 py-1 font-mono text-xs">{spec}</li>)}</ul>
    </section>}
  </section>;
}
function Mentions({ scope, changeId, threadId, t }: { scope: Scope; changeId: string; threadId: string; t: Strings }) {
  const rpc = useRpc<typeof rpcContract>(); const navigate = useBbNavigate();
  const found = useLive(useCallback(() => rpc.call("mentions", { ...scope, changeId }), [rpc, scope, changeId]), false, `mentions:${JSON.stringify([scope, changeId])}`);
  const rows = [...found.data ?? []].sort((a, b) => Number(b.id === threadId) - Number(a.id === threadId));
  return <section className="flex flex-col gap-2">
    <h3 className={sectionLabel}>{t.threads}{found.data ? ` · ${rows.length}` : ""}</h3>
    <ErrorBox error={found.error} t={t} />
    {found.data && !rows.length && <p className="text-xs text-muted-foreground">{t.noMentions}</p>}
    {rows.length > 0 && <ul className="flex flex-col gap-1.5">{rows.map(row => row.id === threadId
      ? <li key={row.id} className="rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-2 break-words">{row.title} <span className="text-[11px] text-primary">· {t.thisThread}</span></li>
      : <li key={row.id} className="rounded-lg border border-border"><button type="button" className="w-full break-words px-2.5 py-2 text-left hover:bg-muted" onClick={() => navigate.toThread(row.id)} aria-label={`${t.openChat}: ${row.title}`}>{row.title}</button></li>)}</ul>}
  </section>;
}
function ReviewDocument({ scope, path, threadId, toolbar, t }: { scope: Scope; path: string; threadId: string; toolbar: HTMLElement | null; t: Strings }) {
  const rpc = useRpc<typeof rpcContract>();
  const query = useLive(useCallback(() => rpc.call("open", { ...scope, path }), [rpc, scope, path]), true, `open:${JSON.stringify([scope, path])}`);
  const [anchor, setAnchor] = useState<Anchor | null>(null); const [body, setBody] = useState(""); const [activeId, setActiveId] = useState<string | null>(null); const [detached, setDetached] = useState(new Set<string>());
  const [showComments, setShowComments] = useState(false); const doc = useRef<HTMLDivElement>(null); const [editId, setEditId] = useState<string | null>(null);
  const action = useAction();
  const data = query.data; const comments = data?.comments ?? []; const open = comments.filter(c => c.status === "open");
  // Stable identity: the highlight effect depends on this list and reports detached ids back.
  const highlighted = useMemo(() => data?.comments.filter(c => c.status !== "closed" || c.id === activeId) ?? [], [data, activeId]);
  // Only open comments are editable: sent ones are already in the chat.
  const editing = comments.find(c => c.id === editId && c.status === "open");
  const closeForm = () => { if (editId) setBody(""); setEditId(null); setAnchor(null); setActiveId(null); };
  // A narrow panel shows the column instead of the document; choosing a comment brings the document back.
  const select = (id: string) => {
    setActiveId(id); if (!doc.current?.checkVisibility()) setShowComments(false);
    const comment = comments.find(c => c.id === id);
    if (comment?.status === "open") { setAnchor(null); setEditId(id); setBody(comment.body); }
  };
  const quote = anchor ?? editing?.anchor;
  // autoFocus scrolls before the floating form is positioned, jerking the panel.
  const form = useRef<HTMLFormElement>(null); const formOpen = Boolean(quote);
  // Any click outside the form drops the form and the active quote; a click on another comment re-selects it.
  useEffect(() => {
    if (!formOpen && !activeId) return;
    const outside = (event: PointerEvent) => { if (!form.current?.contains(event.target as Node)) closeForm(); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [formOpen, editId, activeId]);
  const focusForm = useCallback((element: HTMLTextAreaElement | null) => element?.focus({ preventScroll: true }), []);
  return <section className="space-y-3">
    <ErrorBox error={query.error || action.error} t={t} />
    {query.stale && data && <Notice>{t.stale}</Notice>}
    {query.loading && <Notice>{t.loading}</Notice>}
    {data && <>
      {toolbar && createPortal(<>
        <Button variant={showComments ? "secondary" : "outline"} size="sm" aria-pressed={showComments} onClick={() => setShowComments(!showComments)}>{t.comments} · {comments.length}</Button>
        {!data.missing && open.length > 0 && <Button size="sm" disabled={action.pending} onClick={() => action.run(async () => { await rpc.call("send", { ...scope, docId: data.docId, threadId, ids: open.map(c => c.id) }); query.refresh(); })}>{action.pending ? t.sending : `${t.sendAll} (${open.length})`}</Button>}
      </>, toolbar)}
      <div className={`openspec-review ${showComments ? "openspec-show-comments" : ""}`}>
        <div ref={doc} className="openspec-doc min-w-0">
          {data.missing ? <Notice>{t.missing}</Notice> : <MarkdownReview content={data.content} comments={highlighted} t={t} activeId={activeId} editId={editing ? editId : null} onPick={select} onAnchor={next => { if (editId) { setEditId(null); setBody(""); } setAnchor(next); }} onDetached={setDetached} composer={quote && <form ref={form} className="space-y-2 rounded-lg border border-border p-2.5" onSubmit={e => { e.preventDefault(); action.run(async () => { await (editing ? rpc.call("edit", { ...scope, id: editing.id, body }) : rpc.call("create", { ...scope, docId: data.docId, anchor: quote, body })); setBody(""); setEditId(null); setAnchor(null); query.refresh(); }); }}>
            {editing && <p className="text-xs font-medium">{t.comment} #{editing.seq}</p>}
            {quote.kind === "md-text" && <blockquote className="openspec-quote line-clamp-3 whitespace-pre-wrap border-l-2 border-border pl-3 text-xs text-muted-foreground">{quote.quote}</blockquote>}
            <textarea ref={focusForm} className={textareaClass} aria-label={t.commentBody} placeholder={t.addComment} value={body} maxLength={8000} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} required />
            <div className="flex gap-2"><Button type="submit" size="sm" disabled={action.pending || !body.trim()}>{t.save}</Button><Button type="button" size="sm" variant="outline" onClick={closeForm}>{t.cancel}</Button>{editing && <Button type="button" size="sm" variant="ghost" className="ml-auto text-muted-foreground" disabled={action.pending} aria-label={`${t.remove} #${editing.seq}`} onClick={() => action.run(async () => { await rpc.call("remove", { ...scope, id: editing.id }); closeForm(); query.refresh(); })}>{t.remove}</Button>}</div>
          </form>} />}
        </div>
        {showComments && <Comments scope={scope} docId={data.docId} comments={comments} missing={data.missing} detached={detached} threadId={threadId} activeId={activeId} t={t} onSelect={select} onChanged={query.refresh} />}
      </div>
    </>}
  </section>;
}
function Comments({ scope, docId, comments, missing, detached, threadId, activeId, t, onSelect, onChanged }: { scope: Scope; docId: string; comments: Comment[]; missing: boolean; detached: Set<string>; threadId: string; activeId: string | null; t: Strings; onSelect: (id: string) => void; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>(); const action = useAction();
  const act = (call: () => Promise<unknown>) => action.run(async () => { await call(); onChanged(); });
  const send = (ids: string[]) => act(() => rpc.call("send", { ...scope, docId, threadId, ids }));
  const small = "h-7 px-2 text-xs";
  return <aside className="openspec-comments flex min-w-0 flex-col gap-2" aria-label={t.comments}>
    <ErrorBox error={action.error} t={t} />
    {!comments.length && <p className="text-xs text-muted-foreground">{t.noComments}</p>}
    {comments.map(c => <article key={c.id} className={`flex flex-col gap-1.5 rounded-lg border p-2.5 ${c.id === activeId ? "border-primary/40 bg-primary/5" : "border-border"} ${c.status === "closed" ? "opacity-60" : ""}`}>
      <button type="button" className="text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => onSelect(c.id)}><span className="font-medium text-foreground">#{c.seq}</span> · {t[c.status]}</button>
      {c.anchor.kind === "md-text" && <blockquote className="line-clamp-3 whitespace-pre-wrap border-l-2 border-border pl-2 text-xs text-muted-foreground">{c.anchor.quote}</blockquote>}
      {detached.has(c.id) && c.status !== "closed" && <p className="text-xs text-orange-700 dark:text-orange-400">{t.detached}</p>}
      <p className="whitespace-pre-wrap text-[13px]">{c.body}</p>
      <div className="flex flex-wrap gap-1">
        {c.status === "open" && !missing && <Button size="sm" variant="outline" className={small} disabled={action.pending} aria-label={`${t.send} #${c.seq}`} onClick={() => send([c.id])}>{t.send}</Button>}
        {c.status !== "closed" && <Button size="sm" variant="ghost" className={small} disabled={action.pending} aria-label={`${t.close} #${c.seq}`} onClick={() => act(() => rpc.call("close", { ...scope, id: c.id }))}>{t.close}</Button>}
        <Button size="sm" variant="ghost" className={`${small} text-muted-foreground`} disabled={action.pending} aria-label={`${t.remove} #${c.seq}`} onClick={() => act(() => rpc.call("remove", { ...scope, id: c.id }))}>{t.remove}</Button>
      </div>
    </article>)}
  </aside>;
}
function FileReview({ scope, path, threadId, t }: { scope: Scope; path: string; threadId: string; t: Strings }) {
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  return <div className="space-y-3">
    <div className="openspec-toolbar flex flex-wrap items-start gap-2"><div ref={setToolbar} className="ml-auto flex flex-wrap items-center gap-2" /></div>
    <ReviewDocument scope={scope} path={path} threadId={threadId} toolbar={toolbar} t={t} />
  </div>;
}
// File links in a thread chat: OpenSpec documents get the review, anything else keeps BB's preview.
function SpecFileOpener({ path, source, Original }: PluginFileOpenerProps) {
  return source.kind === "workspace" && source.threadId && /^openspec\/.+\.md$/.test(path) ? <Workspace threadId={source.threadId} path={path} /> : <Original />;
}
const tabRef = { id: "openspec", context: { kind: "thread" }, availability: "action" } as const;
const paramChange = (params: JsonValue | null) => params && typeof params === "object" && !Array.isArray(params) && typeof params.change === "string" ? params.change : undefined;
// Chat header: jump to the latest change, or pick another active one. Hidden where the thread has no OpenSpec root or it fails to load.
function HeaderAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>(); const panel = experimental_useAppPanel();
  const { values } = useSettings(); const t = strings(values?.language);
  const { scope } = useThreadScope(threadId);
  const snapshot = useLive(useCallback(() => scope ? rpc.call("snapshot", scope) : Promise.resolve(null), [rpc, scope]), false, scope ? `snapshot:${JSON.stringify(scope)}` : undefined);
  const changes = snapshot.data?.changes ?? [];
  const latest = latestChange(changes);
  if (!latest) return null;
  const open = (change: string) => panel.experimental_openTab({ surface: { kind: "current" }, tab: tabRef, params: { change }, title: `OpenSpec: ${change}` });
  return <div className="flex items-center gap-1">
    <Button variant="ghost" size="sm" className="max-w-56" aria-label={`OpenSpec ${t.latest}: ${latest.name}`} onClick={() => open(latest.name)}><span className="truncate">{isCompactViewport ? "OpenSpec" : `OpenSpec: ${latest.name}`}</span></Button>
    {changes.length > 1 && <span className="relative flex h-7 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">▾<select aria-label={`OpenSpec: ${t.changes}`} className="absolute inset-0 cursor-pointer opacity-0" value="" onChange={e => e.target.value && open(e.target.value)}>
      <option value="" disabled>{t.changes}</option>
      {changes.map(c => <option key={c.name} value={c.name}>{c.name}{c.totalTasks ? ` · ${c.completedTasks}/${c.totalTasks}` : ""}</option>)}
    </select></span>}
  </div>;
}
export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "openspec", title: "OpenSpec", component: HeaderAction });
  app.slots.fileOpener({ id: "review", title: "OpenSpec review", extensions: ["md"], component: SpecFileOpener });
  app.slots.experimental_tab({ ...tabRef, title: "OpenSpec", icon: "FileText", layout: "flush", component: ({ threadId, params }) => <Workspace threadId={threadId} change={paramChange(params)} /> });
});
