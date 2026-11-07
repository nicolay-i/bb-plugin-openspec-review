import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const temp = resolve(process.cwd(), ".tmp/backend-tests");
mkdirSync(temp, { recursive: true }); process.env.TMPDIR = temp;
let missing = false; let failSend = false; let sendCalls = 0; let archiveCalls = 0; let sentText = ""; let sendMode = ""; let sendResult: any = {}; let queueRows: any[] = []; let historyRows: any[] = [];
const scope = { projectId: "project", environmentId: "env" };
const makeThread = (id: string) => makeThreadResponse({ id, projectId: "project", environmentId: id === "foreign" ? "other-env" : "env", title: id });
const fake = createFakePluginHost({
  pluginId: "openspec-review", dataDir: temp,
  sdk: {
    environments: { get: async () => ({ id: "env", projectId: "project", path: "/checkout", hostId: "host" }) as any },
    hosts: { get: async () => ({ id: "host", status: "connected" }) as any },
    threads: {
      get: async ({ threadId }: any) => makeThread(threadId),
      search: async () => ({ active: { total: 3, results: [
        { thread: makeThread("a"), matches: [{ text: "see openspec/changes/sample/proposal.md" }] },
        { thread: makeThread("b"), matches: [{ text: "a simple fuzzy hit" }] },
        { thread: { ...makeThread("x"), projectId: "other" }, matches: [{ text: "sample" }] },
      ] }, archived: { total: 0, results: [] } }) as any,
      send: async (input: any) => { sendCalls++; sentText = input.input[0].text; sendMode = input.mode; if (failSend) throw new Error("connection lost"); return typeof sendResult === "function" ? sendResult() : sendResult; },
      queuedMessages: { list: async () => queueRows, delete: async ({ queuedMessageId }: any) => { if (!queueRows.some(r => r.id === queuedMessageId)) throw new Error("HTTP 404: Queued message not found"); queueRows = queueRows.filter(r => r.id !== queuedMessageId); return { ok: true }; } } as any,
      promptHistory: async () => historyRows,
      archive: async () => { archiveCalls++; throw new Error("must never archive chats"); },
    },
  },
  experimental_callHostRpc: async ({ method, input }: any) => {
    if (method === "root") return { root: "/checkout" };
    if (method === "watch") return null;
    if (method === "document") return { path: input.path, content: missing ? "" : "# Proposal", missing, version: missing ? "" : "v1" };
    if (method === "detail") return { paths: ["openspec/changes/sample/proposal.md"], artifactFiles: null, status: null, apply: null, title: null, deltas: null, sections: null };
    throw new Error(`Unexpected host method ${method}`);
  },
});
let current = fake;
await plugin(current.bb);
function call(method: string, input: unknown): Promise<any> { return current.harness.behavior.callRpc(method, input as any); }
try {
  const opened = await call("open", { ...scope, path: "openspec/changes/sample/proposal.md" });
  const first = await call("create", { ...scope, docId: opened.docId, anchor: { kind: "md-text", quote: "Proposal", prefix: "", suffix: "" }, body: "Clarify scope" });
  const firstId = first.id;
  await assert.rejects(() => call("send", { ...scope, docId: opened.docId, threadId: "foreign", ids: [firstId] }), /thread_context_mismatch/);
  assert.equal(sendCalls, 0);
  failSend = true;
  await assert.rejects(() => call("send", { ...scope, docId: opened.docId, threadId: "a", ids: [firstId] }), /delivery_not_confirmed/);
  assert.equal(sendCalls, 1, "must not auto-retry an uncertain delivery");
  assert.equal((await call("open", { ...scope, path: opened.path })).comments[0].status, "open");
  failSend = false;
  await call("send", { ...scope, docId: opened.docId, threadId: "a", ids: [firstId] });
  assert.equal(sendMode, "queue-if-active");
  assert.ok(sentText.includes(firstId) && sentText.includes("\"Proposal\"") && sentText.includes("Clarify scope") && sentText.includes(`bb openspec-review review resolve`));
  await assert.rejects(() => call("send", { ...scope, docId: opened.docId, threadId: "a", ids: [firstId] }), /invalid_delivery_selection/, "only open comments are queued");
  assert.equal((await current.harness.behavior.runCli(["review", "resolve", firstId], { threadId: "b" })).exitCode, 1, "other thread cannot close");
  assert.equal((await current.harness.behavior.runCli(["review", "resolve", firstId], { threadId: "a" })).exitCode, 0);
  assert.equal((await call("open", { ...scope, path: opened.path })).comments[0].status, "closed");
  const statusOf = async (id: string) => (await call("open", { ...scope, path: opened.path })).comments.find((c: any) => c.id === id).status;
  const queued = await call("create", { ...scope, docId: opened.docId, anchor: { kind: "doc" }, body: "Queued" });
  sendResult = { ok: true, delivery: "queued", queuedMessage: { id: "q1" } };
  await call("send", { ...scope, docId: opened.docId, threadId: "a", ids: [queued.id] });
  assert.equal(await statusOf(queued.id), "queued");
  await current.harness.behavior.emitThreadEvent("message.cancelled", { entry: { id: "q1" } } as any);
  assert.equal(await statusOf(queued.id), "open", "removed from BB queue → editable again");
  assert.equal((await call("edit", { ...scope, id: queued.id, body: "Queued v2" })).body, "Queued v2");
  // The row dispatches before send() returns: the early event still applies.
  sendResult = async () => { await current.harness.behavior.emitThreadEvent("message.dispatched", { entry: { id: "q2" } } as any); return { ok: true, delivery: "queued", queuedMessage: { id: "q2" } }; };
  await call("send", { ...scope, docId: opened.docId, threadId: "a", ids: [queued.id] });
  assert.equal(await statusOf(queued.id), "sent");
  // Deleting one comment of a queued batch withdraws the message; the other comment reopens.
  const sibling = await call("create", { ...scope, docId: opened.docId, anchor: { kind: "doc" }, body: "Sibling" });
  const batch = await call("create", { ...scope, docId: opened.docId, anchor: { kind: "doc" }, body: "Batch" });
  sendResult = { ok: true, delivery: "queued", queuedMessage: { id: "q3" } }; queueRows = [{ id: "q3" }];
  await call("send", { ...scope, docId: opened.docId, threadId: "a", ids: [sibling.id, batch.id] });
  await call("remove", { ...scope, id: batch.id });
  assert.deepEqual([queueRows.length, await statusOf(sibling.id)], [0, "open"]);
  // Already dispatched (queue 404s): close still succeeds.
  sendResult = { ok: true, delivery: "queued", queuedMessage: { id: "q4" } };
  await call("send", { ...scope, docId: opened.docId, threadId: "a", ids: [sibling.id] });
  assert.equal((await call("close", { ...scope, id: sibling.id })).status, "closed");
  await call("remove", { ...scope, id: sibling.id });
  sendResult = {}; queueRows = [];
  await call("remove", { ...scope, id: queued.id });
  const second = await call("create", { ...scope, docId: opened.docId, anchor: { kind: "doc" }, body: "Drop this" });
  assert.equal((await call("edit", { ...scope, id: second.id, body: "Drop that" })).body, "Drop that");
  assert.equal((await call("close", { ...scope, id: second.id })).status, "closed");
  await call("remove", { ...scope, id: second.id });
  assert.deepEqual((await call("open", { ...scope, path: opened.path })).comments.map((c: any) => c.id), [firstId]);
  await assert.rejects(() => call("remove", { projectId: "wrong", environmentId: "env", id: firstId }), /project_mismatch/);
  const mentions = await call("mentions", { ...scope, changeId: "sample" });
  assert.deepEqual(mentions, [{ id: "a", title: "a" }], "literal mentions in this project only");
  missing = true;
  await call("open", { ...scope, path: opened.path });
  missing = false;
  assert.notEqual((await call("open", { ...scope, path: opened.path })).docId, opened.docId);
  const archived = await call("open", { ...scope, path: "openspec/changes/archive/2026-sample/proposal.md" });
  assert.equal(archived.comments.length, 0); assert.equal(archiveCalls, 0);
  // Queue events missed while unloaded: reload settles from BB's queue and prompt history.
  const live = await call("open", { ...scope, path: opened.path });
  const [keep, gone, done] = await Promise.all(["keep", "gone", "done"].map(body => call("create", { ...scope, docId: live.docId, anchor: { kind: "doc" }, body })));
  for (const [c, q] of [[keep, "q-keep"], [gone, "q-gone"], [done, "q-done"]]) { sendResult = { ok: true, delivery: "queued", queuedMessage: { id: q } }; await call("send", { ...scope, docId: live.docId, threadId: "a", ids: [c.id] }); }
  sendResult = {}; queueRows = [{ id: "q-keep" }]; historyRows = [{ input: [{ type: "text", text: `Review comments\n\n[${done.id}] Whole document\ndone` }] }];
  current = await current.harness.lifecycle.reload(plugin);
  const statuses = async () => Object.fromEntries((await call("open", { ...scope, path: opened.path })).comments.map((c: any) => [c.id, c.status]));
  for (let i = 0; i < 50 && (await statuses())[done.id] === "queued"; i++) await new Promise(r => setTimeout(r, 20));
  const settled = await statuses();
  assert.deepEqual([settled[keep.id], settled[gone.id], settled[done.id]], ["queued", "open", "sent"]);
  assert.equal((await call("open", { ...scope, path: "openspec/changes/archive/2026-sample/proposal.md" })).docId, archived.docId);
  console.log("Backend: queue handoff, uncertain delivery, CLI resolve, close/delete, mention search, independent archive, reload persistence and queue reconcile OK.");
} finally { await current.harness.lifecycle.dispose(); }
