// Comment flow adapted from Doc Review (MIT), Copyright (c) 2026 Foma.
// Source baseline and original notice: docs/doc-review-extraction.md, LICENSES/.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { anchorSchema, commentSchema, type Anchor, type Comment } from "./review-contract.js";

type Db = Pick<Database.Database, "prepare" | "transaction">;
export const migrations = [
  `CREATE TABLE documents (id TEXT PRIMARY KEY, context TEXT NOT NULL, path TEXT NOT NULL, missing INTEGER NOT NULL, version TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1)`,
  `CREATE UNIQUE INDEX live_document ON documents(context, path) WHERE missing = 0`,
  `CREATE TABLE comments (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id), seq INTEGER NOT NULL, status TEXT NOT NULL, anchor TEXT NOT NULL, body TEXT NOT NULL, sent_thread_id TEXT)`,
  `CREATE TABLE replies (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id), author TEXT NOT NULL, body TEXT NOT NULL, outcome TEXT, sent INTEGER NOT NULL)`,
  `CREATE INDEX comment_document ON comments(doc_id, seq)`,
  `CREATE INDEX reply_comment ON replies(comment_id)`,
  `CREATE TABLE links (context TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY(context, kind, item_id, thread_id))`,
  // Simplified review: no replies or manual links; statuses open → sent → closed.
  `UPDATE comments SET status = CASE status WHEN 'draft' THEN 'open' WHEN 'resolved' THEN 'closed' ELSE 'sent' END`,
  `DROP TABLE replies`,
  `DROP TABLE links`,
  // A queued delivery waits for BB's dispatched/cancelled event for this queue row.
  `ALTER TABLE comments ADD COLUMN queued_id TEXT`,
];
export interface StoredDocument { id: string; context: string; path: string; missing: number; version: string }
export class Store {
  constructor(private db: Db) {}
  observe(context: string, path: string, missing: boolean, version: string): StoredDocument {
    return this.db.transaction(() => {
      const live = this.db.prepare("SELECT * FROM documents WHERE context=? AND path=? AND missing=0").get(context, path) as StoredDocument | undefined;
      if (live) {
        this.db.prepare("UPDATE documents SET missing=?, version=? WHERE id=?").run(Number(missing), version, live.id);
        return this.doc(live.id);
      }
      const previous = this.db.prepare("SELECT * FROM documents WHERE context=? AND path=? AND missing=1 ORDER BY rowid DESC LIMIT 1").get(context, path) as StoredDocument | undefined;
      if (missing && previous) return previous;
      const id = `d_${randomUUID()}`;
      this.db.prepare("INSERT INTO documents(id, context, path, missing, version) VALUES(?,?,?,?,?)").run(id, context, path, Number(missing), version);
      return this.doc(id);
    })();
  }
  doc(id: string): StoredDocument {
    const doc = this.db.prepare("SELECT * FROM documents WHERE id=?").get(id) as StoredDocument | undefined;
    if (!doc) throw new Error("document_not_found");
    return doc;
  }
  comments(docId: string): Comment[] {
    const rows = this.db.prepare("SELECT id FROM comments WHERE doc_id=? ORDER BY seq LIMIT 1000").all(docId) as { id: string }[];
    return rows.map(row => this.comment(row.id));
  }
  comment(id: string): Comment {
    const row = this.db.prepare("SELECT * FROM comments WHERE id=?").get(id) as any;
    if (!row) throw new Error("comment_not_found");
    return commentSchema.parse({ id: row.id, docId: row.doc_id, seq: row.seq, status: row.status, anchor: anchorSchema.parse(JSON.parse(row.anchor)), body: row.body, sentThreadId: row.sent_thread_id });
  }
  create(docId: string, anchor: Anchor, body: string) {
    const id = `c_${randomUUID()}`;
    this.db.transaction(() => {
      if (this.doc(docId).missing) throw new Error("document_missing");
      const doc = this.db.prepare("SELECT next_seq FROM documents WHERE id=?").get(docId) as { next_seq: number };
      this.db.prepare("INSERT INTO comments VALUES(?,?,?,'open',?,?,NULL,NULL)").run(id, docId, doc.next_seq, JSON.stringify(anchor), body);
      this.db.prepare("UPDATE documents SET next_seq=next_seq+1 WHERE id=?").run(docId);
    })();
    return this.comment(id);
  }
  edit(id: string, body: string) {
    if (this.db.prepare("UPDATE comments SET body=? WHERE id=? AND status='open'").run(body, id).changes !== 1) throw new Error("comment_not_editable");
    return this.comment(id);
  }
  close(id: string) { this.comment(id); this.db.prepare("UPDATE comments SET status='closed' WHERE id=?").run(id); return this.comment(id); }
  remove(id: string) { this.comment(id); this.db.prepare("DELETE FROM comments WHERE id=?").run(id); }
  markSent(ids: string[], threadId: string, queuedId: string | null = null) {
    this.db.transaction(() => { for (const id of ids) this.db.prepare("UPDATE comments SET status=?, sent_thread_id=?, queued_id=? WHERE id=?").run(queuedId ? "queued" : "sent", threadId, queuedId, id); })();
  }
  queued() { return this.db.prepare("SELECT id, sent_thread_id AS threadId, queued_id AS queuedId FROM comments WHERE status='queued'").all() as { id: string; threadId: string; queuedId: string }[]; }
  /** BB dispatched the queue row: it reached the chat. Returns false when no comment waits on it. */
  dispatched(queuedId: string) { return this.db.prepare("UPDATE comments SET status='sent' WHERE queued_id=? AND status='queued'").run(queuedId).changes > 0; }
  /** The user removed the queue row before dispatch: the comment is editable and sendable again. */
  cancelled(queuedId: string) { return this.db.prepare("UPDATE comments SET status='open', sent_thread_id=NULL, queued_id=NULL WHERE queued_id=? AND status='queued'").run(queuedId).changes > 0; }
  reviewStats(context: string, paths: string[]) {
    const query = this.db.prepare("SELECT COALESCE(SUM(c.status='open'),0) AS open, COALESCE(SUM(c.status IN ('sent','queued')),0) AS sent FROM documents d JOIN comments c ON c.doc_id=d.id WHERE d.context=? AND d.path=? AND d.missing=0");
    return paths.map(path => ({ path, ...(query.get(context, path) as { open: number; sent: number }) }));
  }
}
