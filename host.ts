import { experimental_defineHostEntry, type ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals } from "./src/contracts.js";
import * as workspace from "./src/workspace.js";

const watches = new Map<string, { watch: ExperimentalHostWatchSubscription; seen: number; error: string | null }>();
const pending = new Set<string>();
let disposed = false;
async function remove(token: string) { const entry = watches.get(token); watches.delete(token); await entry?.watch.dispose(); }
const expiry = setInterval(() => {
  for (const [token, entry] of watches) if (Date.now() - entry.seen > 30_000) void remove(token);
}, 10_000);
expiry.unref();
export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    root: async (scope) => ({ root: await workspace.resolveRoot(scope) }),
    async watch({ token, active, ...scope }, context) {
      const root = await workspace.resolveRoot(scope);
      const key = JSON.stringify([root, token]);
      if (!active) { await remove(key); return null; }
      const current = watches.get(key);
      if (current) { if (current.error) throw new Error(current.error); current.seen = Date.now(); return null; }
      if (pending.has(key)) throw new Error("watch_starting");
      if (watches.size + pending.size >= 64) throw new Error("watch_limit: 64 active views per host");
      pending.add(key);
      try {
        let error: string | null = null;
        const watch = await context.experimental_watch({ rootPath: `${root}/openspec`, debounceMs: 300, maxWaitMs: 1000 }, async event => {
          if (event.kind === "watch-error") {
            error = event.message;
            const entry = watches.get(key); if (entry) entry.error = error;
          }
          await context.experimental_emitSignal("changed", { root });
        });
        if (disposed || context.lifecycle.signal.aborted) await watch.dispose();
        else watches.set(key, { watch, seen: Date.now(), error });
      } finally { pending.delete(key); }
      return null;
    },
    snapshot: (input, context) => workspace.snapshot(input, context.signal),
    detail: ({ item, ...scope }, context) => workspace.detail(scope, item, context.signal),
    document: ({ path, ...scope }) => workspace.document(scope, path),
  },
  async dispose() { disposed = true; clearInterval(expiry); await Promise.all([...watches.keys()].map(remove)); },
});
