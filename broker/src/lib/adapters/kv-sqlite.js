/**
 * SQLite KV adapter — mirrors the Cloudflare KV namespace interface:
 *   get(key)                        → string | null
 *   put(key, value, opts?)          → void   (opts.expirationTtl: seconds)
 *   delete(key)                     → void
 *   list({ prefix })                → { keys: [{ name }] }
 *
 * Each KV namespace maps to a separate SQLite table (kv_<ns>).
 * Expired rows are lazily pruned on read and eagerly on put.
 * Requires: better-sqlite3  (npm i better-sqlite3)
 */

export function createSQLiteKVNamespace(db, ns) {
  const table = `kv_${ns.replace(/[^a-z0-9_]/gi, '_')}`;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      key       TEXT PRIMARY KEY,
      value     TEXT NOT NULL,
      expires_at INTEGER
    )
  `);

  const stmts = {
    get: db.prepare(`SELECT value, expires_at FROM ${table} WHERE key = ?`),
    put: db.prepare(`INSERT OR REPLACE INTO ${table} (key, value, expires_at) VALUES (?, ?, ?)`),
    del: db.prepare(`DELETE FROM ${table} WHERE key = ?`),
    list: db.prepare(`SELECT key FROM ${table} WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?)`),
    pruneExpired: db.prepare(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ?`),
  };

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  return {
    async get(key) {
      const row = stmts.get.get(key);
      if (!row) return null;
      if (row.expires_at !== null && row.expires_at <= nowSec()) {
        stmts.del.run(key);
        return null;
      }
      return row.value;
    },

    async put(key, value, opts) {
      const expiresAt = opts?.expirationTtl ? nowSec() + opts.expirationTtl : null;
      stmts.put.run(key, value, expiresAt);
    },

    async delete(key) {
      stmts.del.run(key);
    },

    async list({ prefix = '' } = {}) {
      const now = nowSec();
      // Prune expired rows opportunistically
      stmts.pruneExpired.run(now);
      const rows = stmts.list.all(`${prefix}%`, now);
      return {
        keys: rows.map((r) => ({ name: r.key })),
      };
    },
  };
}
