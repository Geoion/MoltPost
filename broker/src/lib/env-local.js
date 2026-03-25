/**
 * Local env builder — assembles an `env` object that is interface-compatible
 * with the Cloudflare Workers env injected by wrangler.
 *
 * KV_BACKEND=redis  (default) — requires ioredis
 * KV_BACKEND=sqlite           — requires better-sqlite3, no external services
 *
 * QUEUE_BACKEND=redis  (default when KV_BACKEND=redis)
 * QUEUE_BACKEND=none           — disables MSG_QUEUE (queue.js already guards with `if (env.MSG_QUEUE)`)
 *
 * Environment variables read:
 *   KV_BACKEND                   redis | sqlite
 *   QUEUE_BACKEND                redis | none
 *   REDIS_URL                    redis://127.0.0.1:6379
 *   SQLITE_PATH                  ./moltpost.db
 *   PULL_MIN_INTERVAL_SECONDS    300
 *   SEND_RATE_LIMIT_SECONDS      10
 *   DEDUP_WINDOW_SECONDS         86400
 *   PULL_BATCH_SIZE              20
 */

const KV_BACKEND = process.env.KV_BACKEND || 'redis';
const QUEUE_BACKEND = process.env.QUEUE_BACKEND || (KV_BACKEND === 'redis' ? 'redis' : 'none');

async function buildRedisEnv() {
  const { default: Redis } = await import('ioredis');
  const { createRedisKVNamespace } = await import('./adapters/kv-redis.js');
  const { createRedisQueue } = await import('./adapters/queue-redis.js');

  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

  const env = {
    REGISTRY:   createRedisKVNamespace(redis, 'REGISTRY'),
    GROUPS:     createRedisKVNamespace(redis, 'GROUPS'),
    ALLOWLISTS: createRedisKVNamespace(redis, 'ALLOWLISTS'),
    MESSAGES:   createRedisKVNamespace(redis, 'MESSAGES'),

    MSG_QUEUE: QUEUE_BACKEND === 'redis' ? createRedisQueue(redis) : undefined,

    // Expose the redis client so server.mjs can start the consumer
    _redis: redis,

    ...buildVars(),
  };

  return env;
}

async function buildSQLiteEnv() {
  const { default: Database } = await import('better-sqlite3');
  const { createSQLiteKVNamespace } = await import('./adapters/kv-sqlite.js');

  const dbPath = process.env.SQLITE_PATH || './moltpost.db';
  const db = new Database(dbPath);
  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  const env = {
    REGISTRY:   createSQLiteKVNamespace(db, 'REGISTRY'),
    GROUPS:     createSQLiteKVNamespace(db, 'GROUPS'),
    ALLOWLISTS: createSQLiteKVNamespace(db, 'ALLOWLISTS'),
    MESSAGES:   createSQLiteKVNamespace(db, 'MESSAGES'),

    MSG_QUEUE: undefined,

    _db: db,

    ...buildVars(),
  };

  return env;
}

function buildVars() {
  return {
    PULL_MIN_INTERVAL_SECONDS: process.env.PULL_MIN_INTERVAL_SECONDS || '300',
    SEND_RATE_LIMIT_SECONDS:   process.env.SEND_RATE_LIMIT_SECONDS   || '10',
    DEDUP_WINDOW_SECONDS:      process.env.DEDUP_WINDOW_SECONDS      || '86400',
    PULL_BATCH_SIZE:           process.env.PULL_BATCH_SIZE           || '20',
  };
}

/**
 * Build and return a local env object.
 * @returns {Promise<object>} env compatible with Cloudflare Workers env
 */
export async function buildLocalEnv() {
  if (KV_BACKEND === 'sqlite') {
    return buildSQLiteEnv();
  }
  return buildRedisEnv();
}
