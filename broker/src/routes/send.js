/**
 * POST /send
 * Deliver encrypted message to recipient ClawID
 * Phase 1: KV (MESSAGES); Phase 4: Cloudflare Queue
 */

import { getRegistry, getAllowlist } from '../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../middleware/auth.js';
import { auditSend, auditRateLimit } from '../lib/audit.js';
import { enqueue } from '../lib/queue.js';
import { forwardToRemoteBroker } from '../lib/federation.js';

function generateMsgId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function handleSend(request, env, ctx) {
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

  // Parallel read: recipient record, allowlist, dedup, rate limit (all independent)
  const [toRecord, allowlist, dedupRecord, rateLimitTs] = await Promise.all([
    getRegistry(env, to),
    getAllowlist(env, to),
    env.REGISTRY.get(`dedup:${client_msg_id}`),
    env.REGISTRY.get(`ratelimit:send:${from}:${to}`),
  ]);

  // Recipient must exist
  if (!toRecord) {
    return new Response(JSON.stringify({ error: `Recipient not found: ${to}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Recipient allowlist (if configured)
  if (allowlist !== null && !JSON.parse(allowlist).includes(from)) {
    auditSend(from, to, client_msg_id, reqId, 'blocked_allowlist');
    return new Response(
      JSON.stringify({ error: 'Forbidden: sender not in recipient allowlist' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Idempotency dedup (raw value already fetched above)
  if (dedupRecord) {
    return new Response(
      JSON.stringify({ error: 'Duplicate message', client_msg_id }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Rate limit (raw value already fetched above)
  const cooldown = parseInt(env.SEND_RATE_LIMIT_SECONDS || '10', 10);
  if (rateLimitTs !== null) {
    const elapsed = Math.floor(Date.now() / 1000) - parseInt(rateLimitTs, 10);
    if (elapsed < cooldown) {
      const retryAfter = cooldown - elapsed;
      auditRateLimit(from, reqId, retryAfter);
      return new Response(
        JSON.stringify({ error: 'Too Many Requests', retry_after: retryAfter }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
        }
      );
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

  // Enqueue: KV body + pending index + optional Queue hint
  await enqueue(env, to, message);

  // Parallel write: dedup record + rate limit (independent of enqueue result)
  const dedupWindow = parseInt(env.DEDUP_WINDOW_SECONDS || '86400', 10);
  const rateLimitTtl = Math.max(cooldown * 2, 60);
  await Promise.all([
    env.REGISTRY.put(`dedup:${client_msg_id}`, '1', { expirationTtl: dedupWindow }),
    env.REGISTRY.put(`ratelimit:send:${from}:${to}`, String(now), { expirationTtl: rateLimitTtl }),
  ]);

  // last_seen update is non-critical — fire and forget via waitUntil
  const waitUntil = ctx?.waitUntil?.bind(ctx);
  if (waitUntil) {
    waitUntil(
      getRegistry(env, from).then((fromRecord) => {
        if (fromRecord) {
          return env.REGISTRY.put(`registry:${from}`, JSON.stringify({ ...fromRecord, last_seen: now }));
        }
      })
    );
  }

  auditSend(from, to, client_msg_id, reqId, 'ok');

  return new Response(JSON.stringify({ ok: true, msg_id: msgId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
  });
}
