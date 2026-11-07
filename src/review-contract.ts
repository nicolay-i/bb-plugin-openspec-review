import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { documentSchema, scopeSchema } from "./contracts.js";

const id = z.string().min(1).max(200);
export const anchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doc") }).strict(),
  z.object({ kind: z.literal("md-text"), quote: z.string().min(1).max(4000), prefix: z.string().max(200), suffix: z.string().max(200) }).strict(),
]);
export type Anchor = z.infer<typeof anchorSchema>;
export const commentSchema = z.object({ id, docId: id, seq: z.number(), status: z.enum(["open", "queued", "sent", "closed"]), anchor: anchorSchema, body: z.string(), sentThreadId: id.nullable() });
export type Comment = z.infer<typeof commentSchema>;
export const reviewContract = defineRpcContract({
  mentions: { input: scopeSchema.extend({ changeId: id }), output: z.array(z.object({ id, title: z.string() })) },
  open: { input: scopeSchema.extend({ path: z.string().min(1).max(16_384) }), output: documentSchema.extend({ docId: id, comments: z.array(commentSchema) }) },
  reviewStats: { input: scopeSchema.extend({ paths: z.array(z.string().min(1).max(16_384)).max(500) }), output: z.array(z.object({ path: z.string(), open: z.number(), sent: z.number() })) },
  create: { input: scopeSchema.extend({ docId: id, anchor: anchorSchema, body: z.string().trim().min(1).max(8000) }), output: commentSchema },
  edit: { input: scopeSchema.extend({ id, body: z.string().trim().min(1).max(8000) }), output: commentSchema },
  close: { input: scopeSchema.extend({ id }), output: commentSchema },
  remove: { input: scopeSchema.extend({ id }), output: z.null() },
  send: { input: scopeSchema.extend({ docId: id, threadId: id, ids: z.array(id).min(1).max(50) }), output: z.null() },
});
