/**
 * POST /group/send
 * Broadcast or unicast inside a group
 */

import { getGroup } from '../../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../../middleware/auth.js';
import { checkDedup } from '../../middleware/dedup.js';
import { auditGroupSend } from '../../lib/audit.js';
import { enqueue } from '../../lib/queue.js';

function generateMsgId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function handleGroupSend(request, env) {
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

  const { group_id, from: bodyFrom, mode: bodyMode, to: toList, data, client_msg_id, signature, expires_at } = body;
  const from = bodyFrom || auth.clawid;
  const mode = bodyMode || 'broadcast';

  if (!group_id || !data || !client_msg_id) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: group_id, data, client_msg_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (mode !== 'broadcast' && mode !== 'unicast') {
    return new Response(
      JSON.stringify({ error: 'mode must be "broadcast" or "unicast"' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (auth.clawid !== from) {
    return new Response(
      JSON.stringify({ error: 'from does not match authenticated clawid' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const group = await getGroup(env, group_id);
  if (!group) {
    return new Response(JSON.stringify({ error: `Group not found: ${group_id}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Send policy
  const policy = group.policy?.send_policy || 'owner_only';
  if (policy === 'owner_only' && from !== group.owner_clawid) {
    auditGroupSend(group_id, from, mode, reqId, 'forbidden_policy');
    return new Response(
      JSON.stringify({ error: 'Forbidden: only owner can send group messages' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (policy === 'all_members') {
    const isMember = group.members.some((m) => m.clawid === from);
    if (!isMember) {
      auditGroupSend(group_id, from, mode, reqId, 'forbidden_not_member');
      return new Response(
        JSON.stringify({ error: 'Forbidden: not a member of this group' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
  if (policy === 'allowlist') {
    const allowed = group.policy?.allowed_clawids || [];
    if (!allowed.includes(from)) {
      auditGroupSend(group_id, from, mode, reqId, 'forbidden_allowlist');
      return new Response(
        JSON.stringify({ error: 'Forbidden: sender not in group allowlist' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Idempotency
  const dedupCheck = await checkDedup(env, client_msg_id);
  if (dedupCheck.duplicate) return dedupCheck.response;

  // Resolve recipients
  let targets;
  if (mode === 'broadcast') {
    targets = group.members.map((m) => m.clawid).filter((c) => c !== from);
  } else {
    // unicast
    if (!Array.isArray(toList) || toList.length === 0) {
      return new Response(
        JSON.stringify({ error: 'unicast mode requires "to" array' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const memberClawids = new Set(group.members.map((m) => m.clawid));
    targets = toList.filter((c) => memberClawids.has(c) && c !== from);
  }

  const now = Math.floor(Date.now() / 1000);
  const msgTtl = expires_at ? Math.max(expires_at - now, 60) : 86400;
  const deliveredTo = [];

  for (const targetClawid of targets) {
    const msgId = generateMsgId();
    const message = {
      id: msgId,
      from,
      to: targetClawid,
      group_id,
      data,
      client_msg_id,
      signature: signature || null,
      timestamp: now,
      expires_at: expires_at || null,
      delivery_state: 'queued',
      mode,
    };
    await enqueue(env, targetClawid, message);
    deliveredTo.push(targetClawid);
  }

  auditGroupSend(group_id, from, mode, reqId, 'ok');

  return new Response(
    JSON.stringify({ ok: true, group_id, mode, delivered_to: deliveredTo }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId } }
  );
}
