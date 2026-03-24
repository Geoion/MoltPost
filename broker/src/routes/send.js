/**
 * POST /send
 * Deliver encrypted message to recipient ClawID
 * Phase 1: KV (MESSAGES); Phase 4: Cloudflare Queue
 */

import { getRegistry, getAllowlist } from '../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../middleware/auth.js';
import { checkSendRateLimit } from '../middleware/rateLimit.js';
import { checkDedup } from '../middleware/dedup.js';
import { auditSend } from '../lib/audit.js';
import { verifySignature } from '../lib/crypto.js';
import { enqueue } from '../lib/queue.js';
import { forwardToRemoteBroker } from '../lib/federation.js';

function generateMsgId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function handleSend(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const reqId = auth.reqId;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { from, to, data, client_msg_id, timestamp, expires_at, signature, target_broker, attachment, encryption } = body;

  if (!from || !to || !data || !client_msg_id) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: from, to, data, client_msg_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Auth: from must match token clawid
  if (auth.clawid !== from) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: from does not match authenticated clawid' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Federation: forward to target_broker when set
  if (target_broker && typeof target_broker === 'string') {
    auditSend(from, to, client_msg_id, reqId, 'federated');
    const result = await forwardToRemoteBroker(target_broker, body, reqId);
    return new Response(JSON.stringify(result.data), {
      status: result.status,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
    });
  }

  // Recipient must exist
  const toRecord = await getRegistry(env, to);
  if (!toRecord) {
    return new Response(JSON.stringify({ error: `Recipient not found: ${to}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Recipient allowlist (if configured)
  const allowlist = await getAllowlist(env, to);
  if (allowlist !== null && !allowlist.includes(from)) {
    auditSend(from, to, client_msg_id, reqId, 'blocked_allowlist');
    return new Response(
      JSON.stringify({ error: 'Forbidden: sender not in recipient allowlist' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Idempotency dedup before rate limit (rejects duplicates without consuming quota)
  const dedupCheck = await checkDedup(env, client_msg_id);
  if (dedupCheck.duplicate) return dedupCheck.response;

  // Rate limit
  const rateCheck = await checkSendRateLimit(env, from, to, reqId);
  if (rateCheck.limited) return rateCheck.response;

  // Broker-side signature verify when signature is present
  if (signature) {
    const fromRecord = await getRegistry(env, from);
    if (fromRecord?.pubkey) {
      const valid = await verifySignature(fromRecord.pubkey, {
        from,
        to,
        client_msg_id,
        timestamp,
        data,
      }, signature);
      if (!valid) {
        auditSend(from, to, client_msg_id, reqId, 'invalid_signature');
        return new Response(
          JSON.stringify({ error: 'Invalid signature' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  }

  const msgId = generateMsgId();
  const now = Math.floor(Date.now() / 1000);

  // Attachment: validate R2 object when binding exists
  if (attachment) {
    if (!attachment.r2_key || !attachment.hash || !attachment.encrypted_key) {
      return new Response(
        JSON.stringify({ error: 'Invalid attachment: missing r2_key, hash, or encrypted_key' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // When R2 is bound, ensure object exists
    if (env.ATTACHMENTS) {
      const obj = await env.ATTACHMENTS.head(attachment.r2_key);
      if (!obj) {
        return new Response(
          JSON.stringify({ error: `Attachment not found in R2: ${attachment.r2_key}` }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  }

  const message = {
    id: msgId,
    from,
    to,
    data,
    client_msg_id,
    signature: signature || null,
    encryption: encryption || null,
    attachment: attachment || null,
    timestamp: now,
    expires_at: expires_at || null,
    delivery_state: 'queued',
  };

  // Phase 4: enqueue (KV body + index + Queue)
  await enqueue(env, to, message);

  // Update sender last_seen
  const fromRecord = await getRegistry(env, from);
  if (fromRecord) {
    fromRecord.last_seen = now;
    const { setRegistry } = await import('../lib/kv.js');
    await setRegistry(env, from, fromRecord);
  }

  auditSend(from, to, client_msg_id, reqId, 'ok');

  return new Response(JSON.stringify({ ok: true, msg_id: msgId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
  });
}
