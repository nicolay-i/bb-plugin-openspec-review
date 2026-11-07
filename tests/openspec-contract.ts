// Run: bun --install=force run tests/openspec-contract.ts
// Integration check: requires the documented OpenSpec 1.9.0 JSON contract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const project = resolve(import.meta.dir, "..");
mkdirSync(join(project, ".tmp"), { recursive: true });
const root = mkdtempSync(join(project, ".tmp/openspec-contract-"));
const env = { ...process.env, OPENSPEC_TELEMETRY: "0", OPENSPEC_NO_UPDATE_CHECK: "1" };
// Isolate OpenSpec's user schema/config/registry without reading real credentials.
for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
  env[key] = join(root, "user");
}
function cli(args: string[], expected = 0) {
  const result = spawnSync("openspec", args, { cwd: root, env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `openspec ${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  return result;
}
function file(relative: string, content: string) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const examples: Record<string, unknown> = {};
function json(name: string, args: string[], expected = 0): any {
  const output = JSON.parse(cli([...args, "--json"], expected).stdout);
  examples[name] = output;
  return output;
}
const version = cli(["--version"]).stdout.trim();
assert.match(version, /^1\.9\./, `Contract not verified for OpenSpec ${version}`);
cli(["init", "--tools", "none", "--no-animation"]);
assert.deepEqual(json("empty", ["list"]).changes, []);
const artifactIds = ["proposal", "research", "tasks"];
file("openspec/schemas/review-first/schema.yaml", JSON.stringify({
  name: "review-first", version: 1, description: "Contract check with a custom artifact",
  artifacts: artifactIds.map((id, index) => ({
    id, generates: `${id}.md`, description: `Contract ${id}`, template: `${id}.md`,
    instruction: `Write ${id}`, requires: index ? [artifactIds[index - 1]] : [],
  })),
  apply: { requires: ["tasks"], tracks: "tasks.md", instruction: "Complete tasks" },
}));
for (const id of artifactIds) file(`openspec/schemas/review-first/templates/${id}.md`, `# ${id}\n`);
cli(["new", "change", "sample-change", "--schema", "review-first", "--json"]);
const status = json("custom-status", ["status", "--change", "sample-change"]);
assert.equal(status.schemaName, "review-first");
assert.deepEqual(status.artifacts.map((a: any) => a.id), ["proposal", "research", "tasks"]);
assert.ok(status.artifacts.some((a: any) => a.status === "blocked"));
assert.equal(status.root.path, root);
assert.ok(status.artifactPaths.research.resolvedOutputPath.endsWith("research.md"));
file("openspec/specs/identity/auth/spec.md", "# Auth\n\n## Purpose\nAuthentication behavior for the contract check.\n\n## Requirements\n\n### Requirement: Login\nThe system SHALL accept valid credentials.\n\n#### Scenario: Valid login\n- **WHEN** credentials are valid\n- **THEN** access is granted\n");
assert.equal(json("spec-list", ["list", "--specs"]).specs[0].id, "identity/auth");
file("openspec/changes/sample-change/proposal.md", "## Why\nContract check\n");
file("openspec/changes/sample-change/research.md", "# Research\nContract check\n");
file("openspec/changes/sample-change/tasks.md", "## 1. Work\n- [x] 1.1 Complete\n- [ ] 1.2 Pending\n");
const change = json("change-list", ["list"]).changes[0];
assert.equal(change.completedTasks, 1);
assert.equal(change.totalTasks, 2);
assert.equal(change.status, "in-progress");
const apply = json("apply", ["instructions", "apply", "--change", "sample-change"]);
assert.equal(apply.progress.total, 2);
assert.equal(apply.progress.complete, 1);
assert.equal(apply.state, "ready");
const badChange = cli(["status", "--change", "missing", "--json"], 1);
assert.ok(badChange.stderr.includes("missing") || badChange.stdout.includes("missing"));
const badFlag = cli(["list", "--not-a-real-flag"], 1);
assert.match(badFlag.stderr, /unknown option/i);
// Save only synthetic outputs, with the temporary path stripped from every string.
const destination = join(project, "tests/fixtures/openspec-1.9.json");
mkdirSync(dirname(destination), { recursive: true });
const sanitized = JSON.stringify({ version, ...examples }, null, 2).split(root).join("<ROOT>");
assert.ok(!sanitized.includes(project));
writeFileSync(destination, `${sanitized}\n`);
assert.ok(readFileSync(destination, "utf8").includes("research"));
console.log(`OpenSpec ${version}: list/specs/custom schema/tasks/errors OK; synthetic fixtures saved.`);
