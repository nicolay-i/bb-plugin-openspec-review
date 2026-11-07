import { stat } from "node:fs/promises";
import path from "node:path";

// npm's .cmd launcher is not executable by execFile without a shell.
// Use its adjacent official JS entrypoint, preserving PATH installation order.
export async function windowsCliCommand(args: string[], searchPaths: string[]) {
  for (const directory of searchPaths.filter(Boolean)) {
    const prefix = directory.replace(/^"(.*)"$/, "$1");
    try {
      if (!(await stat(path.join(prefix, "openspec.cmd"))).isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const entry = path.join(prefix, "node_modules", "@fission-ai", "openspec", "bin", "openspec.js");
    try {
      if (!(await stat(entry)).isFile()) throw new Error("not_a_file");
    } catch {
      throw new Error("unsupported_cli_installation: Windows requires the standard npm global @fission-ai/openspec installation");
    }
    return { executable: process.execPath, args: [entry, ...args] };
  }
  throw new Error("cli_missing: install OpenSpec 1.9.x on the selected host");
}
