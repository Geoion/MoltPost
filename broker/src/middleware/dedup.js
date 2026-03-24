/**
 * Idempotency: reject duplicate client_msg_id within window (default 60s)
 *
 * Two-phase design: checkDedup only reads (no side effects), markDedup writes
 * after the message is successfully enqueued. This prevents failed sends from
 * consuming the dedup slot and causing spurious 409s on retry.
 */

import { getDedupRecord, setDedupRecord } from '../lib/kv.js';

export async function checkDedup(env, clientMsgId) {
  if (!clientMsgId) {
    return { duplicate: false };
  }

  const existing = await getDedupRecord(env, clientMsgId);
  if (existing) {
    return {
      duplicate: true,
      response: new Response(
        JSON.stringify({ error: 'Duplicate message', client_msg_id: clientMsgId }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  return { duplicate: false };
}

export async function markDedup(env, clientMsgId) {
  if (!clientMsgId) return;
  const dedupWindow = parseInt(env.DEDUP_WINDOW_SECONDS || '60', 10);
  await setDedupRecord(env, clientMsgId, dedupWindow);
}
