import type { Detail, Item, Snapshot } from "./contracts.js";

export function planningProgress(artifacts: NonNullable<Detail["status"]>["artifacts"]) {
  return { complete: artifacts.filter(a => a.status === "done").length, total: artifacts.filter(a => a.status !== "skipped").length };
}
export function itemExists(snapshot: Snapshot, item: Item) {
  if (item.kind === "spec") return snapshot.specs.some(s => s.id === item.id);
  if (item.kind === "change") return snapshot.changes.some(c => c.name === item.id);
  return snapshot.archive.some(a => a.id === item.id);
}
