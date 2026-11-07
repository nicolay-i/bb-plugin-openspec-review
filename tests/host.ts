import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk";
import entry from "../host.ts";
const base = resolve(process.cwd(), ".tmp/host-tests"); await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "root-")); await mkdir(join(root, "openspec/changes"), { recursive: true });
let starts = 0; let disposals = 0; let listener!: ExperimentalHostWatchListener;
const harness = experimental_createHostEntryHarness(entry, {
  experimental_paths: { dataDir: base, tempDir: base },
  experimental_watch: async (options, callback) => { starts++; assert.equal(options.rootPath, `${root}/openspec`); listener = callback; return { dispose: async () => { disposals++; } }; },
});
const input = { checkout: root, cwd: root, token: "view-a", active: true };
try {
  await harness.experimental_call("watch", input);
  await harness.experimental_call("watch", input);
  assert.equal(starts, 1, "renewal must reuse the native subscription");
  await listener({ kind: "rescan-required" });
  assert.equal(harness.experimental_getSignals()[0].signal, "changed");
  await harness.experimental_call("watch", { ...input, active: false }); assert.equal(disposals, 1);
  await harness.experimental_call("watch", input); assert.equal(starts, 2);
  await listener({ kind: "watch-error", message: "permission_denied" });
  await assert.rejects(() => harness.experimental_call("watch", input), /permission_denied/);
  await assert.rejects(() => harness.experimental_call("document", { checkout: root, cwd: root, path: "../outside.md" }), /invalid_document_path/);
} finally { await harness.experimental_dispose(); }
assert.equal(disposals, 2); assert.ok(harness.experimental_lifecycleSignal.aborted);
console.log("Host: watch renewal, invalidation signal, explicit stop, watch error and unload disposal OK.");
