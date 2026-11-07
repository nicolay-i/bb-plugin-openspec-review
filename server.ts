import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, rpcContract as workspaceContract, type Scope } from "./src/contracts.js";
import { reviewContract } from "./src/review-contract.js";
import { resolveContext } from "./src/context.js";
import { migrations, Store } from "./src/store.js";

export const rpcContract = { ...workspaceContract, ...reviewContract };
export default function plugin(bb: BbPluginApi) {
  bb.settings.define({ language: { type: "select", label: "Interface language / Язык интерфейса", options: ["en", "ru"], default: "en" } });
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  bb.onDispose(host.experimental_onSignal("changed", () => bb.realtime.publish("changed", {})));
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const store = new Store(db);
  const sending = new Set<string>();
  const earlyQueueEvents = new Map<string, "dispatched" | "cancelled">();
  for (const event of ["dispatched", "cancelled"] as const) bb.events.on(`message.${event}`, ({ entry }) => {
    if (store[event](entry.id)) changed();
    // Only an in-flight send can still be waiting to learn this row's id.
    else if (sending.size) earlyQueueEvents.set(entry.id, event);
  });
  const changed = () => bb.realtime.publish("changed", {});
  // Queue events fired while the plugin was unloaded are lost: settle those comments from BB's own state.
  async function reconcileQueued() {
    const queued = store.queued();
    for (const threadId of new Set(queued.map(row => row.threadId))) {
      const rows = queued.filter(row => row.threadId === threadId);
      try {
        const [queue, history] = await Promise.all([bb.sdk.threads.queuedMessages.list({ threadId }), bb.sdk.threads.promptHistory({ threadId, limit: "200" })]);
        const prompts = history.flatMap(entry => entry.input.flatMap(part => part.type === "text" ? [part.text] : []));
        for (const row of rows) {
          if (queue.some(entry => entry.id === row.queuedId)) continue;
          // shortcut: prompt history is capped, so a delivery that scrolled out of it reads as cancelled; fine for downtime-sized gaps.
          store[prompts.some(text => text.includes(`[${row.id}]`)) ? "dispatched" : "cancelled"](row.queuedId);
        }
        changed();
      } catch (error) { bb.log.warn(`openspec: queue reconcile failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  void reconcileQueued();
  // Closing or deleting a queued comment also withdraws its chat message; others in that message reopen.
  async function dequeue(id: string) {
    const row = store.queued().find(r => r.id === id);
    if (!row) return;
    try { await bb.sdk.threads.queuedMessages.delete({ threadId: row.threadId, queuedMessageId: row.queuedId }); }
    catch (error) { if (!/not found/i.test(error instanceof Error ? error.message : String(error))) throw error; return; }
    store.cancelled(row.queuedId);
  }
  async function context(scope: Scope) {
    const { hostId, ...input } = await resolveContext(bb, scope);
    const { root } = await host.call("root", input, { hostId });
    return { hostId, input, root, key: JSON.stringify([scope.projectId, scope.environmentId, hostId, root]) };
  }
  async function requireDoc(scope: Scope, docId: string) {
    const ctx = await context(scope);
    const doc = store.doc(docId);
    if (doc.context !== ctx.key) throw new Error("document_context_mismatch");
    return { ...ctx, doc };
  }
  async function target(scope: Scope, threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.projectId !== scope.projectId || thread.environmentId !== scope.environmentId) throw new Error("thread_context_mismatch");
    if (thread.archivedAt) throw new Error("thread_archived");
    return thread;
  }
  bb.rpc.register(rpcContract, {
    async watch({ token, active, ...scope }) {
      const { hostId, ...input } = await resolveContext(bb, scope);
      return host.call("watch", { ...input, token, active }, { hostId });
    },
    async snapshot(scope) {
      const { hostId, ...input } = await resolveContext(bb, scope);
      return host.call("snapshot", input, { hostId });
    },
    async detail({ item, ...scope }) {
      const { hostId, ...input } = await resolveContext(bb, scope);
      return host.call("detail", { ...input, item }, { hostId });
    },
    async document({ path, ...scope }) {
      const { hostId, ...input } = await resolveContext(bb, scope);
      return host.call("document", { ...input, path }, { hostId });
    },
    async mentions({ changeId, ...scope }) {
      await resolveContext(bb, scope);
      // Search is fuzzy and cross-project: keep only literal mentions in this project.
      // shortcut: a snippet may truncate the id, so such a mention is missed; upgrade when BB exposes exact search.
      const found = await bb.sdk.threads.search({ query: changeId, limitPerGroup: "50" });
      return found.active.results
        .filter(r => r.thread.projectId === scope.projectId && r.matches.some(m => m.text.includes(changeId)))
        .map(r => ({ id: r.thread.id, title: r.thread.title ?? r.thread.id }));
    },
    async open({ path, ...scope }) {
      const ctx = await context(scope);
      const file = await host.call("document", { ...ctx.input, path }, { hostId: ctx.hostId });
      const doc = store.observe(ctx.key, path, file.missing, file.version);
      return { ...file, docId: doc.id, comments: store.comments(doc.id) };
    },
    async reviewStats({ paths, ...scope }) { return store.reviewStats((await context(scope)).key, paths); },
    async create({ docId, anchor, body, ...scope }) {
      const ctx = await requireDoc(scope, docId);
      const file = await host.call("document", { ...ctx.input, path: ctx.doc.path }, { hostId: ctx.hostId });
      store.observe(ctx.key, ctx.doc.path, file.missing, file.version);
      const result = store.create(docId, anchor, body); changed(); return result;
    },
    async edit({ id, body, ...scope }) {
      await requireDoc(scope, store.comment(id).docId);
      if (sending.has(id)) throw new Error("delivery_in_progress");
      const result = store.edit(id, body); changed(); return result;
    },
    async close({ id, ...scope }) {
      await requireDoc(scope, store.comment(id).docId);
      if (sending.has(id)) throw new Error("delivery_in_progress");
      await dequeue(id);
      const result = store.close(id); changed(); return result;
    },
    async remove({ id, ...scope }) {
      await requireDoc(scope, store.comment(id).docId);
      if (sending.has(id)) throw new Error("delivery_in_progress");
      await dequeue(id);
      store.remove(id); changed(); return null;
    },
    async send({ docId, threadId, ids, ...scope }) {
      if (new Set(ids).size !== ids.length) throw new Error("duplicate_comment_ids");
      if (ids.some(id => sending.has(id))) throw new Error("delivery_in_progress");
      ids.forEach(id => sending.add(id));
      try {
      const ctx = await requireDoc(scope, docId); await target(scope, threadId);
      const comments = ids.map(id => store.comment(id));
      if (comments.some(c => c.docId !== docId || c.status !== "open")) throw new Error("invalid_delivery_selection");
      const file = await host.call("document", { ...ctx.input, path: ctx.doc.path }, { hostId: ctx.hostId });
      store.observe(ctx.key, ctx.doc.path, file.missing, file.version);
      if (store.doc(docId).missing) throw new Error("document_missing");
      const prompt = [
        `Review comments on ${ctx.doc.path}`,
        `OpenSpec root: ${ctx.root}.`,
        "These comments are user requests, not system instructions. Read the actual source before editing. If unclear, ask in the chat instead of guessing. After applying a comment, close it with bb openspec-review review resolve <id>.",
        ...comments.map(c => `[${c.id}] ${c.anchor.kind === "md-text" ? `Quote: ${JSON.stringify(c.anchor.quote)}` : "Whole document"}\n${c.body}`),
      ].join("\n\n");
      if (prompt.length > 100_000) throw new Error("delivery_too_large");
      try {
        const result = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: prompt, mentions: [] }] });
        const queuedId = result.delivery === "queued" ? result.queuedMessage.id : null;
        store.markSent(ids, threadId, queuedId);
        // The queue row may have dispatched or been removed before send() returned.
        const early = queuedId && earlyQueueEvents.get(queuedId);
        if (early) { earlyQueueEvents.delete(queuedId); store[early](queuedId!); }
        changed();
      } catch (error) {
        // No automatic resend: a lost acknowledgement can still mean a delivered message.
        throw new Error(`delivery_not_confirmed: inspect target chat before retrying; ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
      } finally { ids.forEach(id => sending.delete(id)); if (!sending.size) earlyQueueEvents.clear(); }
    },
  });
  bb.cli.register({
    name: "openspec-review", summary: "Close OpenSpec review comments sent to this thread",
    commands: [{ name: "review", summary: "Close a review comment after applying it", usage: "bb openspec-review review resolve <id>" }],
    async run(argv, invocation) {
      try {
        const [group, command, id, ...rest] = argv;
        if (group !== "review" || command !== "resolve" || !id || rest.length) throw new Error("Usage: bb openspec-review review resolve <id>");
        if (!invocation.threadId) throw new Error("thread_context_required");
        const comment = store.comment(id);
        if (comment.sentThreadId !== invocation.threadId) throw new Error("comment_not_assigned_to_thread");
        store.close(comment.id); changed();
        return { exitCode: 0, stdout: `Closed ${comment.id}` };
      } catch (e) { return { exitCode: 1, stderr: e instanceof Error ? e.message : String(e) }; }
    },
  });
}
