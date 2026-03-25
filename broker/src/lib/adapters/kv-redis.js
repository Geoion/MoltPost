/**
 * Redis KV adapter — mirrors the Cloudflare KV namespace interface:
 *   get(key)                        → string | null
 *   put(key, value, opts?)          → void   (opts.expirationTtl: seconds)
 *   delete(key)                     → void
 *   list({ prefix })                → { keys: [{ name }] }
 *
 * Each KV namespace is isolated by a Redis key prefix (ns).
 * Requires: ioredis  (npm i ioredis)
 *
 * Extended native List interface (only present on MESSAGES namespace):
 *   listAppend(key, value)          → void   — atomic RPUSH
 *   listGetAll(key)                 → string[]
 *   listRemove(key, values)         → void   — remove matching elements
 *
 * kv.js detects these methods via `env.MESSAGES._nativeList` and uses them
 * for pending-index operations to eliminate the read-modify-write round trip.
 * Cloudflare KV path is unaffected.
 */

export function createRedisKVNamespace(redis, ns) {
  const prefixed = (key) => `kv:${ns}:${key}`;

  const base = {
    async get(key) {
      return redis.get(prefixed(key));
    },

    async put(key, value, opts) {
      const pk = prefixed(key);
      if (opts?.expirationTtl) {
        await redis.set(pk, value, 'EX', opts.expirationTtl);
      } else {
        await redis.set(pk, value);
      }
    },

    async delete(key) {
      await redis.del(prefixed(key));
    },

    async list({ prefix = '' } = {}) {
      // KEYS is fine for dev/low-volume; swap to SCAN for production
      const pattern = prefixed(`${prefix}*`);
      const raw = await redis.keys(pattern);
      const strip = `kv:${ns}:`;
      return {
        keys: raw.map((k) => ({ name: k.slice(strip.length) })),
      };
    },
  };

  // Native List extension — only wired up for MESSAGES namespace in env-local.js
  const nativeList = {
    async listAppend(key, value) {
      await redis.rpush(prefixed(key), value);
    },

    async listGetAll(key) {
      return redis.lrange(prefixed(key), 0, -1);
    },

    async listRemove(key, values) {
      // LREM count=0 removes all occurrences of each value
      await Promise.all(values.map((v) => redis.lrem(prefixed(key), 0, v)));
    },

    async listDelete(key) {
      await redis.del(prefixed(key));
    },
  };

  return Object.assign(base, { _nativeList: nativeList });
}
