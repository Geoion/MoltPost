/**
 * POST /pull
 * Fetch pending messages for authenticated ClawID
 * Phase 1: KV; Phase 4: Queue-backed dequeue
 */

import { getRegistry, setRegistry } from '../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../middleware/auth.js';
import { checkPullRateLimit } from '../middleware/rateLimit.js';
import { auditPull } from '../lib/audit.js';
import { dequeueForClawid } from '../lib/queue.js';

export async function handlePull(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const reqId = auth.reqId;
  const clawid = auth.clawid;

  // Min interval between pulls
  const rateCheck = await checkPullRateLimit(env, clawid, reqId);
  if (rateCheck.limited) return rateCheck.response;

  const batchSize = parseInt(env.PULL_BATCH_SIZE || '10', 10);
  const now = Math.floor(Date.now() / 1000);

  // Phase 4: dequeue via KV index (TTL handled inside)
  const { messages } = await dequeueForClawid(env, clawid, batchSize);

  // Bump last_seen
  const record = await getRegistry(env, clawid);
  if (record) {
    record.last_seen = now;
    await setRegistry(env, clawid, record);
  }

  auditPull(clawid, messages.length, reqId);

  return new Response(
    JSON.stringify({ messages, count: messages.length }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
    }
  );
}
