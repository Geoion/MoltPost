/**
 * Idempotency: reject duplicate client_msg_id within window (default 60s)
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

  const dedupWindow = parseInt(env.DEDUP_WINDOW_SECONDS || '60', 10);
  await setDedupRecord(env, clientMsgId, dedupWindow);
  return { duplicate: false };
}
