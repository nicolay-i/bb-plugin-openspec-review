import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const scopeSchema = z.object({ projectId: z.string().min(1), environmentId: z.string().min(1) }).strict();
export type Scope = z.infer<typeof scopeSchema>;
const text = z.string().max(16_384);
export const hostScopeSchema = z.object({ checkout: text.min(1), cwd: text.min(1) }).strict();
export type HostScope = z.infer<typeof hostScopeSchema>;
export const rootSchema = z.object({ path: text.min(1), source: z.literal("nearest") }).passthrough();
export const changeSchema = z.object({ name: text.min(1), completedTasks: z.number().int().nonnegative(), totalTasks: z.number().int().nonnegative(), lastModified: z.string(), status: z.enum(["no-tasks", "complete", "in-progress"]) }).passthrough();
export const specSchema = z.object({ id: text.min(1), requirementCount: z.number().int().nonnegative() }).passthrough();
export const changesSchema = z.object({ root: rootSchema, changes: z.array(changeSchema).max(2000) });
export const specsSchema = z.object({ root: rootSchema, specs: z.array(specSchema).max(2000) });
export const artifactSchema = z.object({ id: text.min(1), outputPath: text, status: z.enum(["done", "ready", "blocked", "skipped"]), requires: z.array(text), missingDeps: z.array(text).optional() }).passthrough();
export const statusSchema = z.object({ root: rootSchema, changeName: text, schemaName: text, changeRoot: text,
  isPlanningComplete: z.boolean(), artifacts: z.array(artifactSchema).max(200),
  artifactPaths: z.record(z.string(), z.object({ outputPath: text, resolvedOutputPath: text, existingOutputPaths: z.array(text).max(2000) })),
}).passthrough();
export const progressSchema = z.object({ total: z.number().int().nonnegative(), complete: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() });
export const applySchema = z.object({ root: rootSchema, progress: progressSchema, tasks: z.array(z.object({ id: text, description: text, done: z.boolean() })).max(5000), state: z.enum(["blocked", "ready", "all_done"]) });
export const showSchema = z.object({ root: rootSchema, title: text, deltas: z.array(z.object({ spec: text.min(1), operation: z.enum(["ADDED", "MODIFIED", "REMOVED", "RENAMED"]) }).passthrough()).max(5000) }).passthrough();
export const sectionSchema = z.object({ title: text, complete: z.number().int().nonnegative(), total: z.number().int().nonnegative() });
export const itemSchema = z.object({ kind: z.enum(["spec", "change", "archive"]), id: text.min(1) }).strict();
export type Item = z.infer<typeof itemSchema>;
export const documentSchema = z.object({ path: text, content: z.string().max(4 * 1024 * 1024), version: z.string(), missing: z.boolean() });
export const snapshotSchema = z.object({ root: text, version: text, changes: z.array(changeSchema), specs: z.array(specSchema), archive: z.array(z.object({ id: text, paths: z.array(text) })) });
export const detailSchema = z.object({ paths: z.array(text), artifactFiles: z.record(text, z.array(text)).nullable(), status: statusSchema.nullable(), apply: applySchema.nullable(),
  title: text.nullable(), deltas: z.array(z.object({ spec: text, operation: showSchema.shape.deltas.element.shape.operation })).nullable(), sections: z.array(sectionSchema).nullable() });
export const hostContract = defineRpcContract({
  root: { input: hostScopeSchema, output: z.object({ root: text }) },
  watch: { input: hostScopeSchema.extend({ token: z.string().min(1).max(100), active: z.boolean() }), output: z.null() },
  snapshot: { input: hostScopeSchema, output: snapshotSchema },
  detail: { input: hostScopeSchema.extend({ item: itemSchema }), output: detailSchema },
  document: { input: hostScopeSchema.extend({ path: text.min(1) }), output: documentSchema },
});
export const rpcContract = defineRpcContract({
  watch: { input: scopeSchema.extend({ token: z.string().min(1).max(100), active: z.boolean() }), output: z.null() },
  snapshot: { input: scopeSchema, output: snapshotSchema },
  detail: { input: scopeSchema.extend({ item: itemSchema }), output: detailSchema },
  document: { input: scopeSchema.extend({ path: text.min(1) }), output: documentSchema },
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Detail = z.infer<typeof detailSchema>;
export const hostSignals = { changed: { payload: z.object({ root: text }) } };
