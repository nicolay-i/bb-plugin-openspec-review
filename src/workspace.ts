import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, realpath, stat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { windowsCliCommand } from "./windows-cli.js";
import { applySchema, changesSchema, showSchema, specsSchema, statusSchema, type HostScope, type Item } from "./contracts.js";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 5000;
export function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export async function safePath(root: string, relative: string) {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || relative.includes("\\")) throw new Error("path_outside_root");
  const base = await realpath(root);
  const target = await realpath(path.join(base, relative));
  if (!inside(base, target)) throw new Error("path_outside_root");
  return target;
}
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
export async function resolveRoot(scope: HostScope) {
  const checkout = await realpath(scope.checkout);
  let current = await realpath(scope.cwd);
  if (!inside(checkout, current)) throw new Error("path_outside_checkout");
  while (true) {
    let planning: string | undefined;
    try { planning = await safePath(current, "openspec"); } catch (e) { if (!missing(e)) throw e; }
    if (planning) {
      if (!(await stat(planning)).isDirectory()) throw new Error("invalid_openspec_root");
      // A config-only root may point at an external store. Do not invoke CLI there.
      let local = false;
      for (const name of ["specs", "changes"]) {
        try { const dir = await safePath(planning, name); if (!(await stat(dir)).isDirectory()) throw new Error("invalid_openspec_root"); local = true; }
        catch (e) { if (!missing(e)) throw e; }
      }
      if (!local) throw new Error("unsupported_config_only_root");
      return current;
    }
    if (current === checkout) throw new Error("no_openspec_root");
    current = path.dirname(current);
  }
}

/** Reject escaping symlinks before passing the planning tree to the external CLI. */
export async function filesUnder(root: string, relative: string, optional = false) {
  const files: string[] = [];
  let count = 0;
  const visited = new Set<string>();
  async function walk(relativeDir: string, depth: number): Promise<void> {
    if (depth > 40) throw new Error("workspace_too_deep");
    const dir = await safePath(root, relativeDir);
    if (visited.has(dir)) throw new Error("symlink_cycle");
    visited.add(dir);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++count > MAX_ENTRIES) throw new Error("workspace_too_large");
      const rel = `${relativeDir}/${entry.name}`;
      const full = await safePath(root, rel);
      const info = await stat(full);
      if (info.isDirectory()) await walk(rel, depth + 1);
      else if (info.isFile()) files.push(rel);
      else throw new Error("unsupported_file_type");
    }
  }
  if (optional) {
    try { await safePath(root, relative); } catch (e) { if (missing(e)) return []; throw e; }
  }
  await walk(relative, 0);
  return files.sort();
}

export async function textFile(root: string, relative: string) {
  const full = await safePath(root, relative);
  // Open only the checked canonical file and cap bytes even if it grows after stat.
  const handle = await open(full, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("document_too_large");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("document_too_large");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return { path: relative, content, version: createHash("sha256").update(content).digest("hex"), missing: false };
  } finally { await handle.close(); }
}

export async function executeCli(args: string[], cwd: string, signal?: AbortSignal, executable = "openspec") {
  const command = process.platform === "win32" && executable === "openspec"
    ? await windowsCliCommand(args, (process.env.PATH ?? "").split(path.delimiter))
    : { executable, args };
  return new Promise<string>((resolve, reject) => {
    execFile(command.executable, command.args, {
      cwd, signal, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: MAX_BYTES, encoding: "utf8", windowsHide: true,
      env: { ...process.env, OPENSPEC_TELEMETRY: "0", OPENSPEC_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new Error(code === "ENOENT" ? "cli_missing: install OpenSpec 1.9.x on the selected host" : `cli_failed: ${String(code ?? error.message)}; ${stderr.slice(0, 2000)}`));
      } else resolve(stdout);
    });
  });
}
// Each CLI start costs ~2 s. Outputs are reused until a file under openspec/ or PATH changes.
// shortcut: global user schemas outside openspec/ are not in the fingerprint; edits there need a planning-file change to show.
const cliCache = new Map<string, { fingerprint: string; outputs: Map<string, string> }>();
async function cachedCli(args: string[], root: string, fingerprint: string, signal?: AbortSignal) {
  const key = JSON.stringify([root, process.env.PATH]);
  let entry = cliCache.get(key);
  if (entry?.fingerprint !== fingerprint) cliCache.set(key, entry = { fingerprint, outputs: new Map() });
  const id = args.join("\0"); const hit = entry.outputs.get(id);
  if (hit !== undefined) return hit;
  const output = await executeCli(args, root, signal);
  entry.outputs.set(id, output);
  return output;
}
export async function readCli<T>(args: string[], root: string, schema: z.ZodType<T>, signal?: AbortSignal, fingerprint?: string) {
  const output = fingerprint ? await cachedCli([...args, "--json"], root, fingerprint, signal) : await executeCli([...args, "--json"], root, signal);
  const parsed = schema.safeParse(parseCliJson(output));
  if (!parsed.success) throw new Error(`unsupported_cli_contract: expected OpenSpec 1.9.x; ${parsed.error.issues.map(i => i.path.join(".")).slice(0, 4).join(", ")}`);
  const selected = (parsed.data as { root?: { path: string; source: string } }).root;
  if (!selected || selected.source !== "nearest" || await realpath(selected.path) !== root) throw new Error("unexpected_cli_root");
  return parsed.data;
}
export function parseCliJson(output: string): unknown {
  try { return JSON.parse(output); } catch { throw new Error("invalid_cli_json: expected OpenSpec 1.9.x JSON"); }
}
// The version depends on the installed CLI, not on planning files: checking it per fingerprint added a serial ~2 s to every cold read.
// shortcut: an in-place CLI upgrade under the same PATH is seen after a host restart.
const versions = new Map<string, string>();
async function cliVersion(root: string, signal?: AbortSignal) {
  const key = JSON.stringify([root, process.env.PATH]);
  let version = versions.get(key);
  if (version === undefined) versions.set(key, version = (await executeCli(["--version"], root, signal)).trim());
  return version;
}
async function prepare(scope: HostScope, signal?: AbortSignal) {
  const root = await resolveRoot(scope);
  const files = await filesUnder(root, "openspec");
  const stats = await Promise.all(files.map(file => stat(path.join(root, file))));
  const fingerprint = createHash("sha256").update(JSON.stringify(files.map((file, i) => [file, stats[i].size, stats[i].mtimeMs]))).digest("hex");
  const version = await cliVersion(root, signal);
  if (!/^1\.9\.\d+$/.test(version)) throw new Error(`unsupported_cli_version: ${version}; required 1.9.x`);
  return { root, version, fingerprint };
}
export async function snapshot(scope: HostScope, signal?: AbortSignal) {
  const { root, version, fingerprint } = await prepare(scope, signal);
  const [changes, specs, archivedFiles] = await Promise.all([
    readCli(["list"], root, changesSchema, signal, fingerprint),
    readCli(["list", "--specs"], root, specsSchema, signal, fingerprint),
    filesUnder(root, "openspec/changes/archive", true),
  ]);
  const groups = new Map<string, string[]>();
  for (const file of archivedFiles.filter(p => p.endsWith(".md"))) {
    const id = file.split("/")[3];
    if (!id) continue;
    const paths = groups.get(id) ?? []; paths.push(file); groups.set(id, paths);
  }
  return { root, version, changes: changes.changes, specs: specs.specs, archive: [...groups].map(([id, paths]) => ({ id, paths })).sort((a, b) => b.id.localeCompare(a.id)) };
}
function validId(id: string) {
  if (!id || id.startsWith("/") || id.includes("\\") || id.split("/").some(p => !p || p === "." || p === "..") || id.includes("\0")) throw new Error("invalid_item_id");
}
export async function detail(scope: HostScope, item: Item, signal?: AbortSignal) {
  validId(item.id);
  const { root, fingerprint } = await prepare(scope, signal);
  if (item.kind === "spec") {
    const rel = `openspec/specs/${item.id}/spec.md`;
    await safePath(root, rel);
    return { paths: [rel], artifactFiles: null, status: null, apply: null, title: null, deltas: null, sections: null };
  }
  if (item.id.includes("/")) throw new Error("invalid_change_id");
  if (item.kind === "archive") return { paths: (await filesUnder(root, `openspec/changes/archive/${item.id}`)).filter(p => p.endsWith(".md")), artifactFiles: null, status: null, apply: null, title: null, deltas: null, sections: null };
  // OpenSpec 1.9 `show` fails with show_error until proposal.md exists.
  const proposal = safePath(root, `openspec/changes/${item.id}/proposal.md`).then(() => true, e => { if (missing(e)) return false; throw e; });
  const [status, apply, shown] = await Promise.all([
    readCli(["status", "--change", item.id], root, statusSchema, signal, fingerprint),
    readCli(["instructions", "apply", "--change", item.id], root, applySchema, signal, fingerprint),
    proposal.then(exists => exists ? readCli(["show", item.id, "--type", "change", "--deltas-only"], root, showSchema, signal, fingerprint) : null),
  ]);
  const paths: string[] = []; const artifactFiles: Record<string, string[]> = {};
  for (const [id, artifact] of Object.entries(status.artifactPaths)) {
    artifactFiles[id] = [];
    for (const full of artifact.existingOutputPaths) {
      const rel = path.relative(root, full).split(path.sep).join("/");
      await safePath(root, rel); paths.push(rel); artifactFiles[id].push(rel);
    }
  }
  let sections = null;
  // The CLI does not expose the schema's tracked file: accept only a single-file artifact whose checkboxes equal apply.tasks.
  for (const files of apply.tasks.length ? Object.values(artifactFiles) : []) {
    if (files.length !== 1) continue;
    sections = taskSections((await textFile(root, files[0])).content, apply.tasks);
    if (sections) break;
  }
  return { paths: [...new Set(paths)], artifactFiles, status, apply, title: shown?.title ?? null, deltas: shown?.deltas.map(d => ({ spec: d.spec, operation: d.operation })) ?? null, sections };
}
const TASK_LINE = /^\s*[-*]\s*\[([\sxX])\]\s*(.*)/; // Same pattern as OpenSpec 1.9 task-progress.
export function taskSections(content: string, tasks: { description: string; done: boolean }[]) {
  const sections: { title: string; complete: number; total: number }[] = []; let index = 0;
  for (const line of content.split("\n")) {
    const heading = /^##\s+(.+)/.exec(line);
    if (heading) { sections.push({ title: heading[1].trim(), complete: 0, total: 0 }); continue; }
    const task = TASK_LINE.exec(line);
    if (!task) continue;
    const done = task[1].toLowerCase() === "x"; const expected = tasks[index++]; const section = sections.at(-1);
    if (!section || expected?.description !== task[2].trim() || expected.done !== done) return null;
    section.total++; if (done) section.complete++;
  }
  return index === tasks.length ? sections.filter(s => s.total) : null;
}
export async function document(scope: HostScope, relative: string) {
  if (!relative.startsWith("openspec/") || !relative.endsWith(".md")) throw new Error("invalid_document_path");
  const root = await resolveRoot(scope);
  try { return await textFile(root, relative); }
  catch (e) { if (!missing(e)) throw e; return { path: relative, content: "", version: "", missing: true }; }
}
