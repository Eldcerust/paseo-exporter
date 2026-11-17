import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// A rebuildable cache of conversation text, kept next to the catalog receipts. The export files and
// the daemon stay the source of truth; deleting search.sqlite only costs a re-read. It uses the
// runtime's built-in SQLite (FTS5), so there is nothing to install and no native module to build.
const SCHEMA_VERSION = 1;
const MAX_QUERY_TERMS = 12;
export const INDEX_FILENAME = "search.sqlite";

export type DocKind = "file" | "chat";
export interface IndexDoc {
  kind: DocKind;
  /** Export file path for a file, agent id for a chat. */
  key: string;
  agentId: string | null;
  title: string;
  /** Provider, folder, path and ids: searchable but ranked below the title and the text. */
  meta: string;
  body: string;
  /** Changes whenever the source changes: size and mtime for a file, archive time for a chat. */
  stamp: string;
  /** Newest first when several documents describe one chat. */
  sortKey: string;
  payload: string;
}
export interface SearchHit { key: string; agentId: string | null; snippet: string; rank: number }
export interface SearchIndex {
  stamp(kind: DocKind, key: string): string | undefined;
  payload(kind: DocKind, key: string): string | undefined;
  keys(kind: DocKind): string[];
  put(doc: IndexDoc): void;
  remove(kind: DocKind, key: string): void;
  /** Title of the newest saved export of this chat. */
  titleFor(agentId: string): string | undefined;
  search(query: string, kind: DocKind, limit: number): SearchHit[];
}
export interface SearchIndexProvider {
  /**
   * Runs `work` with the index open, then closes it, so no file handle outlives the call. The index
   * is null when the runtime has no SQLite or the file cannot be opened; `reason()` says why.
   * An error thrown by `work` propagates unchanged.
   */
  use<T>(context: Pick<PluginHandlerContext, "paseo">, work: (index: SearchIndex | null) => Promise<T>): Promise<T>;
  reason(): string | null;
}

/**
 * Turns what a person typed into an FTS5 query: every word must appear, and each matches as a
 * prefix, so "purg" finds "purge". Punctuation never reaches the query parser, so a path, a flag
 * or a quote cannot be read as FTS5 syntax. Returns null when there is nothing to search for.
 */
export function toMatchQuery(query: string) {
  const terms = query.normalize("NFKC").split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean).slice(0, MAX_QUERY_TERMS);
  return terms.length ? terms.map((term) => `"${term}"*`).join(" ") : null;
}

export async function hostCatalogDirectory(catalogRoot: string, { paseo }: Pick<PluginHandlerContext, "paseo">) {
  const { self } = await paseo.hosts.list();
  return join(catalogRoot, createHash("sha256").update(self.serverId).digest("hex").slice(0, 24));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isCorrupt = (error: unknown) => /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(message(error)) || [11, 26].includes((error as { errcode?: number })?.errcode ?? -1);

async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  // The specifier is not a literal so a bundler cannot fail the whole plugin when a runtime lacks it.
  const specifier = "node:sqlite";
  try { return await import(specifier); }
  catch (error) { throw new Error(`Text search needs a Node.js runtime with node:sqlite (22.13 or newer): ${message(error)}`); }
}

function prepare(db: DatabaseSync) {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
  const version = () => Number((db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
  if (version() === SCHEMA_VERSION) return;
  // Any other version is an old or foreign layout. The index is only a cache, so start it over.
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another connection may have finished this while this one waited for the write lock.
    if (version() !== SCHEMA_VERSION) db.exec(`
      DROP TABLE IF EXISTS docs_fts;
      DROP TABLE IF EXISTS docs;
      CREATE TABLE docs (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, agent_id TEXT,
        title TEXT NOT NULL, stamp TEXT NOT NULL, sort_key TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE UNIQUE INDEX docs_by_key ON docs(kind, key);
      CREATE INDEX docs_by_agent ON docs(agent_id, kind, sort_key);
      CREATE VIRTUAL TABLE docs_fts USING fts5(title, meta, body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the original error matters */ }
    throw error;
  }
}

function createIndex(db: DatabaseSync, onCorrupt: () => void): SearchIndex {
  const statement = (sql: string): StatementSync => db.prepare(sql);
  const sql = {
    stamp: statement("SELECT stamp FROM docs WHERE kind = ? AND key = ?"),
    payload: statement("SELECT payload FROM docs WHERE kind = ? AND key = ?"),
    id: statement("SELECT id FROM docs WHERE kind = ? AND key = ?"),
    keys: statement("SELECT key FROM docs WHERE kind = ?"),
    insertDoc: statement("INSERT INTO docs(kind, key, agent_id, title, stamp, sort_key, payload) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    insertText: statement("INSERT INTO docs_fts(rowid, title, meta, body) VALUES (?, ?, ?, ?)"),
    deleteDoc: statement("DELETE FROM docs WHERE id = ?"),
    deleteText: statement("DELETE FROM docs_fts WHERE rowid = ?"),
    title: statement("SELECT title FROM docs WHERE kind = 'file' AND agent_id = ? ORDER BY sort_key DESC LIMIT 1"),
    // Column -1 lets SQLite show the passage from whichever column matched. Title counts most, then the
    // path/provider line, then the conversation text. char(1) and char(2) are the highlight markers.
    search: statement(`
      SELECT d.key AS key, d.agent_id AS agent_id,
             snippet(docs_fts, -1, char(1), char(2), '…', 24) AS snippet,
             bm25(docs_fts, 10.0, 3.0, 1.0) AS rank
      FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE docs_fts MATCH ? AND d.kind = ?
      ORDER BY rank LIMIT ?`),
  };
  const guard = <T>(run: () => T): T => {
    try { return run(); }
    catch (error) { if (isCorrupt(error)) onCorrupt(); throw error; }
  };
  const remove = (kind: DocKind, key: string) => {
    const row = sql.id.get(kind, key) as { id: number } | undefined;
    if (!row) return;
    sql.deleteText.run(row.id);
    sql.deleteDoc.run(row.id);
  };
  const inTransaction = (work: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try { work(); db.exec("COMMIT"); }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* the original error matters */ } throw error; }
  };
  return {
    stamp: (kind, key) => guard(() => (sql.stamp.get(kind, key) as { stamp: string } | undefined)?.stamp),
    payload: (kind, key) => guard(() => (sql.payload.get(kind, key) as { payload: string } | undefined)?.payload),
    keys: (kind) => guard(() => (sql.keys.all(kind) as Array<{ key: string }>).map((row) => row.key)),
    put: (doc) => guard(() => inTransaction(() => {
      remove(doc.kind, doc.key);
      const { lastInsertRowid } = sql.insertDoc.run(doc.kind, doc.key, doc.agentId, doc.title, doc.stamp, doc.sortKey, doc.payload);
      sql.insertText.run(Number(lastInsertRowid), doc.title, doc.meta, doc.body);
    })),
    remove: (kind, key) => guard(() => inTransaction(() => remove(kind, key))),
    titleFor: (agentId) => guard(() => (sql.title.get(agentId) as { title: string } | undefined)?.title),
    search: (query, kind, limit) => guard(() => {
      const match = toMatchQuery(query);
      if (!match) return [];
      return (sql.search.all(match, kind, limit) as Array<{ key: string; agent_id: string | null; snippet: string | null; rank: number }>)
        .map((row) => ({ key: row.key, agentId: row.agent_id, snippet: row.snippet ?? "", rank: Number(row.rank) }));
    }),
  };
}

async function removeDatabase(file: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(`${file}${suffix}`, { force: true });
}

export function createSearchIndexProvider({ catalogRoot }: { catalogRoot: string }): SearchIndexProvider {
  let failure: string | null = null;

  async function openDatabase(file: string) {
    const { DatabaseSync } = await loadSqlite();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const attempt = () => {
      const db = new DatabaseSync(file);
      try { prepare(db); } catch (error) { try { db.close(); } catch { /* already unusable */ } throw error; }
      const entry = { db, broken: false, index: undefined as unknown as SearchIndex };
      entry.index = createIndex(db, () => { entry.broken = true; });
      return entry;
    };
    try { return attempt(); }
    catch (error) {
      // Only an unreadable file is thrown away. A locked or unwritable one must not cost the index.
      if (!isCorrupt(error)) throw error;
      await removeDatabase(file);
      return attempt();
    }
  }

  return {
    async use(context, work) {
      let file: string | null = null;
      let opened: Awaited<ReturnType<typeof openDatabase>> | null = null;
      try {
        file = join(await hostCatalogDirectory(catalogRoot, context), INDEX_FILENAME);
        opened = await openDatabase(file);
        failure = null;
      } catch (error) { failure = message(error); }
      try { return await work(opened?.index ?? null); }
      finally {
        if (opened) {
          try { opened.db.close(); } catch { /* closing twice is fine */ }
          // A query reported corruption: drop the file so the next call starts empty and the listing re-reads every export.
          if (opened.broken && file) await removeDatabase(file).catch(() => {});
        }
      }
    },
    reason: () => failure,
  };
}
