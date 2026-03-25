/**
 * Local Node.js server for MoltPost Broker
 *
 * Replaces Cloudflare Workers when running self-hosted.
 * Uses the same route handlers as the Workers entry (src/index.js) —
 * zero changes to business logic.
 *
 * Usage:
 *   node broker/server.mjs
 *
 * Environment variables:
 *   PORT                         3000
 *   KV_BACKEND                   redis | sqlite
 *   QUEUE_BACKEND                redis | none
 *   REDIS_URL                    redis://127.0.0.1:6379
 *   SQLITE_PATH                  ./moltpost.db
 *   PULL_MIN_INTERVAL_SECONDS    300
 *   SEND_RATE_LIMIT_SECONDS      10
 *   DEDUP_WINDOW_SECONDS         86400
 *   PULL_BATCH_SIZE              20
 */

import { createServer } from 'node:http';
import { buildLocalEnv } from './src/lib/env-local.js';
import worker from './src/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

// Node.js fetch globals are available since v18; polyfill not needed.

async function main() {
  const env = await buildLocalEnv();

  // Start Redis Streams consumer if queue backend is redis
  if (env._redis && process.env.QUEUE_BACKEND !== 'none') {
    const { startQueueConsumer } = await import('./src/lib/adapters/queue-redis.js');
    const { handleQueueBatch } = await import('./src/lib/queue.js');
    startQueueConsumer(env._redis, env, handleQueueBatch);
    console.log('[moltpost] Redis Streams consumer started');
  }

  const server = createServer(async (req, res) => {
    // Build a Web API Request from the Node.js IncomingMessage
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : null;

    const url = `http://${req.headers.host || `localhost:${PORT}`}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body?.length ? body : undefined,
      // duplex is required when body is a stream/buffer in Node 18+
      duplex: body?.length ? 'half' : undefined,
    });

    let response;
    try {
      response = await worker.fetch(request, env, {});
    } catch (err) {
      console.error('[moltpost] unhandled error', err);
      response = new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Write Web API Response back to Node.js ServerResponse
    res.statusCode = response.status;
    for (const [key, value] of response.headers) {
      res.setHeader(key, value);
    }
    const responseBody = await response.arrayBuffer();
    res.end(Buffer.from(responseBody));
  });

  server.listen(PORT, () => {
    console.log(`[moltpost] broker listening on http://localhost:${PORT}`);
    console.log(`[moltpost] KV backend: ${process.env.KV_BACKEND || 'redis'}`);
    console.log(`[moltpost] Queue backend: ${process.env.QUEUE_BACKEND || (process.env.KV_BACKEND === 'sqlite' ? 'none' : 'redis')}`);
  });

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[moltpost] shutting down (${sig})`);
      server.close(() => {
        if (env._redis) env._redis.quit();
        if (env._db) env._db.close();
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  console.error('[moltpost] startup error', err);
  process.exit(1);
});
