/**
 * Redis Streams Queue adapter — mirrors the Cloudflare Queue producer interface:
 *   send(body)   → void
 *
 * Also provides a consumer loop that mimics the Cloudflare Queue consumer
 * (handleQueueBatch), reading from a Redis Stream with a consumer group.
 *
 * Stream key: moltpost-messages
 * Consumer group: moltpost-consumers
 *
 * Requires: ioredis  (npm i ioredis)
 */

const STREAM_KEY = 'moltpost-messages';
const GROUP_NAME = 'moltpost-consumers';
const CONSUMER_NAME = `consumer-${process.pid}`;
const BATCH_SIZE = 10;
const BLOCK_MS = 5000;

export function createRedisQueue(redis) {
  return {
    async send(body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      await redis.xadd(STREAM_KEY, '*', 'body', payload);
    },
  };
}

/**
 * Ensure the consumer group exists (idempotent).
 */
async function ensureGroup(redis) {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
  } catch (err) {
    // BUSYGROUP means it already exists — safe to ignore
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

/**
 * Start consuming messages from the Redis Stream.
 * Calls handleQueueBatch(batch, env) with a Cloudflare-compatible batch object.
 *
 * @param {object} redis  - ioredis client
 * @param {object} env    - local env (KV namespaces, vars)
 * @param {Function} handleQueueBatch - imported from queue.js
 */
export async function startQueueConsumer(redis, env, handleQueueBatch) {
  await ensureGroup(redis);

  async function poll() {
    try {
      // Read new messages ('>') with blocking wait
      const results = await redis.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'COUNT', BATCH_SIZE,
        'BLOCK', BLOCK_MS,
        'STREAMS', STREAM_KEY, '>'
      );

      if (results) {
        for (const [, entries] of results) {
          const messages = entries.map(([id, fields]) => {
            const bodyStr = fields[fields.indexOf('body') + 1];
            let body;
            try { body = JSON.parse(bodyStr); } catch { body = bodyStr; }

            return {
              id,
              body,
              ack() { redis.xack(STREAM_KEY, GROUP_NAME, id); },
              retry() { /* message stays in PEL for re-delivery */ },
            };
          });

          await handleQueueBatch({ messages }, env);
        }
      }
    } catch (err) {
      console.error(JSON.stringify({ op: 'queue_consumer_poll_error', error: err.message }));
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Continue polling
    setImmediate(poll);
  }

  poll();
}
