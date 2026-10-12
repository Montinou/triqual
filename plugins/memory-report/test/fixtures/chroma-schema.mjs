// Fixture helper: a Chroma store with the real `embeddings` and `embedding_metadata` columns (spec 2). node:sqlite is
// loaded inside the function so importing this file works on Node 20; tests skip themselves when it is unavailable.
import { createRequire } from 'node:module';

const DDL = [
  `CREATE TABLE embeddings (
    id INTEGER PRIMARY KEY, segment_id TEXT NOT NULL, embedding_id TEXT NOT NULL, seq_id BLOB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE embedding_metadata (
    id INTEGER REFERENCES embeddings(id), key TEXT NOT NULL, string_value TEXT, int_value INTEGER, float_value REAL,
    bool_value INTEGER, PRIMARY KEY (id, key))`,
];

// Creates `path` with one embeddings row per document and one embedding_metadata row per key: `sqlite_id` in
// int_value, `doc_type` and `project` in string_value. A key whose value is undefined gets no row.
export function createChromaDb(path, docs = []) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    for (const ddl of DDL) db.exec(ddl);
    const addDoc = db.prepare('INSERT INTO embeddings (id, segment_id, embedding_id, seq_id) VALUES (?, ?, ?, ?)');
    const addInt = db.prepare('INSERT INTO embedding_metadata (id, key, int_value) VALUES (?, ?, ?)');
    const addStr = db.prepare('INSERT INTO embedding_metadata (id, key, string_value) VALUES (?, ?, ?)');
    for (const doc of docs) {
      addDoc.run(doc.id, 'segment', `doc-${doc.id}`, Buffer.from([0]));
      if (doc.sqlite_id !== undefined) addInt.run(doc.id, 'sqlite_id', doc.sqlite_id);
      if (doc.doc_type !== undefined) addStr.run(doc.id, 'doc_type', doc.doc_type);
      if (doc.project !== undefined) addStr.run(doc.id, 'project', doc.project);
    }
  } finally {
    db.close();
  }
}
