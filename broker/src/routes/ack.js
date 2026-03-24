/**
 * POST /ack
 * Client confirms delivery; remove from pending / message store
 */

import { authenticate, unauthorizedResponse } from '../middleware/auth.js';
import { auditAck } from '../lib/audit.js';
import { ackMessages } from '../lib/queue.js';

export async function handleAck(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const reqId = auth.reqId;
  const clawid = auth.clawid;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { msg_ids } = body;

  if (!Array.isArray(msg_ids) || msg_ids.length === 0) {
    return new Response(JSON.stringify({ error: 'msg_ids must be a non-empty array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Phase 4: ack removes KV index entries and bodies
  await ackMessages(env, clawid, msg_ids);

  auditAck(clawid, msg_ids, reqId);

  return new Response(JSON.stringify({ ok: true, acked: msg_ids.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
  });
}
