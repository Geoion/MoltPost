/**
 * POST /group/invite
 * Owner issues invite token for /group/join
 */

import { getGroup, setInviteToken } from '../../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../../middleware/auth.js';

function generateInviteToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleGroupInvite(request, env) {
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

  const { group_id, expires_in_hours = 24 } = body;

  if (!group_id) {
    return new Response(JSON.stringify({ error: 'Missing group_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const group = await getGroup(env, group_id);
  if (!group) {
    return new Response(JSON.stringify({ error: `Group not found: ${group_id}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Only owner may mint invites
  if (auth.clawid !== group.owner_clawid) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: only owner can generate invite tokens' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const token = generateInviteToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expires_in_hours * 3600;
  const ttl = expires_in_hours * 3600;

  await setInviteToken(env, token, { group_id, created_at: now, expires_at: expiresAt }, ttl);

  return new Response(
    JSON.stringify({ ok: true, invite_token: token, expires_at: expiresAt }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId } }
  );
}
