import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { executeCli, snapshot, detail, taskSections, document, resolveRoot, safePath, readCli, parseCliJson } from "../src/workspace.js";
import { changesSchema } from "../src/contracts.js";
import { resolveContext } from "../src/context.js";

const base = resolve(import.meta.dir, "../.tmp");
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, "workspace-"));
const checkout = join(root, "checkout");
await mkdir(join(checkout, "nested"), { recursive: true });
const home = join(root, "user");
Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, OPENSPEC_TELEMETRY: "0", OPENSPEC_NO_UPDATE_CHECK: "1" });
function cli(args: string[]) {
  const result = spawnSync("openspec", args, { cwd: checkout, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
cli(["init", "--tools", "none", "--no-animation"]);
const scope = { checkout, cwd: join(checkout, "nested") };
assert.equal(await resolveRoot(scope), checkout);
assert.equal((await snapshot(scope)).changes.length, 0);
cli(["new", "change", "pending", "--json"]);
// Incomplete planning is a valid detail, not a CLI error.
const pending = await detail(scope, { kind: "change", id: "pending" });
assert.ok(pending.status?.artifacts.some(a => a.status === "ready"));
assert.equal(pending.apply?.state, "blocked");
assert.equal(pending.deltas, null); // No proposal yet: `show` is not called.
assert.equal(pending.sections, null);
const changeDir = join(checkout, "openspec/changes/pending");
await mkdir(join(changeDir, "specs/auth"), { recursive: true });
await writeFile(join(changeDir, "proposal.md"), "# Change: Вход через Google\n\n## Why\nNeed login.\n\n## What Changes\n- Add login\n");
await writeFile(join(changeDir, "specs/auth/spec.md"), "## ADDED Requirements\n\n### Requirement: A\nSystem SHALL a.\n\n#### Scenario: A\n- **WHEN** x\n- **THEN** y\n\n### Requirement: B\nSystem SHALL b.\n\n#### Scenario: B\n- **WHEN** x\n- **THEN** y\n");
await writeFile(join(changeDir, "tasks.md"), "## 1. Providers\n\n- [x] 1.1 Google\n- [ ] 1.2 GitHub\n\n## 2. Tests\n\n- [ ] 2.1 E2E\n");
const planned = await detail(scope, { kind: "change", id: "pending" });
assert.equal(planned.title, "Вход через Google");
assert.deepEqual(planned.deltas, [{ spec: "auth", operation: "ADDED" }, { spec: "auth", operation: "ADDED" }]);
const tasks = [{ description: "1.1 A", done: true }];
assert.equal(taskSections("- [x] 1.1 A\n", tasks), null, "task outside a section");
assert.equal(taskSections("## 1\n- [ ] 1.1 A\n", tasks), null, "done mismatch");
assert.equal(taskSections("## 1\n- [x] 1.1 A\n- [ ] 1.2 B\n", tasks), null, "extra task");
assert.deepEqual(taskSections("## 1\r\n  - [X] 1.1 A\r\n### Sub\n## Empty\n", tasks), [{ title: "1", complete: 1, total: 1 }]);
assert.deepEqual(planned.sections, [{ title: "1. Providers", complete: 1, total: 2 }, { title: "2. Tests", complete: 0, total: 1 }]);
// Unchanged files reuse cached CLI output (one CLI start is ~2 s); an edit invalidates it.
const started = performance.now();
assert.deepEqual(await detail(scope, { kind: "change", id: "pending" }), planned);
assert.ok(performance.now() - started < 1000, "unchanged planning files must not start the CLI");
await writeFile(join(changeDir, "tasks.md"), "## 1. Providers\n\n- [x] 1.1 Google\n- [x] 1.2 GitHub\n\n## 2. Tests\n\n- [ ] 2.1 E2E\n");
assert.deepEqual((await detail(scope, { kind: "change", id: "pending" })).apply?.progress, { total: 3, complete: 2, remaining: 1 });
await mkdir(join(checkout, "openspec/specs/identity/auth"), { recursive: true });
await writeFile(join(checkout, "openspec/specs/identity/auth/spec.md"), "# Auth\n\n## Purpose\nAuth behavior\n\n## Requirements\n\n### Requirement: Access\nSystem SHALL grant access.\n\n#### Scenario: Access\n- **WHEN** valid\n- **THEN** granted\n");
assert.equal((await snapshot(scope)).specs[0].id, "identity/auth");
assert.equal((await detail(scope, { kind: "spec", id: "identity/auth" })).paths[0], "openspec/specs/identity/auth/spec.md");
const doc = await document(scope, "openspec/specs/identity/auth/spec.md");
assert.ok(doc.content.includes("SHALL"));
assert.equal(doc.version.length, 64);
assert.equal((await document(scope, "openspec/specs/missing/spec.md")).missing, true);
await mkdir(join(checkout, "openspec/changes/archive/2026-01-01-old"), { recursive: true });
await writeFile(join(checkout, "openspec/changes/archive/2026-01-01-old/proposal.md"), "# Archived\n");
assert.equal((await snapshot(scope)).archive[0].id, "2026-01-01-old");
assert.equal((await detail(scope, { kind: "archive", id: "2026-01-01-old" })).status, null);
await assert.rejects(() => safePath(checkout, "../outside.md"), /outside/);
await assert.rejects(() => safePath(checkout, join(root, "outside.md")), /outside/);
await writeFile(join(root, "outside.md"), "never return this");
await symlink(join(root, "outside.md"), join(checkout, "openspec/specs/escape.md"));
await assert.rejects(() => document(scope, "openspec/specs/escape.md"), /outside/);
await assert.rejects(() => snapshot(scope), /outside/);
await unlink(join(checkout, "openspec/specs/escape.md"));
assert.throws(() => parseCliJson("not JSON"), /invalid_cli_json/);
await assert.rejects(() => executeCli(["-e", "process.stdout.write('x'.repeat(5*1024*1024))"], checkout, undefined, process.execPath), /cli_failed/);
const abort = new AbortController(); abort.abort();
await assert.rejects(() => executeCli(["--version"], checkout, abort.signal), /cli_failed/);
const oldPath = process.env.PATH;
const bin = join(root, "bin"); await mkdir(bin);
await writeFile(join(bin, "openspec"), "#!/bin/sh\nprintf '2.0.0\\n'\n", { mode: 0o755 });
try {
  process.env.PATH = bin;
  await assert.rejects(() => snapshot(scope), /unsupported_cli_version: 2\.0\.0/);
} finally { process.env.PATH = oldPath; }
await assert.rejects(() => executeCli([], checkout, undefined, join(root, "missing-cli")), /cli_missing/);
await assert.rejects(() => executeCli(["--not-real"], checkout), /cli_failed/);
await assert.rejects(() => readCli(["status", "--change", "pending"], checkout, changesSchema), /unsupported_cli_contract/);
const empty = join(root, "empty"); await mkdir(empty);
await assert.rejects(() => resolveRoot({ checkout: empty, cwd: empty }), /no_openspec_root/);
await mkdir(join(empty, "openspec")); await writeFile(join(empty, "openspec/config.yaml"), "store: remote-store\n");
await assert.rejects(() => resolveRoot({ checkout: empty, cwd: empty }), /unsupported_config_only/);
await assert.rejects(() => resolveRoot({ checkout, cwd: empty }), /outside_checkout/);
const fake = (projectId: string, status = "connected") => ({ sdk: {
  environments: { get: async () => ({ projectId, path: checkout, hostId: "host" }) },
  hosts: { get: async () => ({ status }) },
} }) as any;
await assert.rejects(() => resolveContext(fake("other"), { projectId: "project", environmentId: "env" }), /project_mismatch/);
await assert.rejects(() => resolveContext(fake("project", "disconnected"), { projectId: "project", environmentId: "env" }), /host_disconnected/);
assert.equal((await resolveContext(fake("project"), { projectId: "project", environmentId: "env" })).hostId, "host");
console.log("Workspace: local root, nested spec, archive, blocked planning, traversal, symlink, CLI and context errors OK.");
