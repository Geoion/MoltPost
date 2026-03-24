/**
 * POST /group/join
 * Join with invite token
 */

import { getGroup, setGroup, getRegistry, getInviteToken, deleteInviteToken } from '../../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../../middleware/auth.js';

export async function handleGroupJoin(request, env) {
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

  const { group_id, clawid: bodyClawid, invite_token } = body;
  const clawid = bodyClawid || auth.clawid;

  if (!group_id || !invite_token) {
    return new Response(
      JSON.stringify({ error: 'Missing group_id or invite_token' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (auth.clawid !== clawid) {
    return new Response(
      JSON.stringify({ error: 'clawid must match authenticated clawid' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate invite
  const inviteData = await getInviteToken(env, invite_token);
  if (!inviteData || inviteData.group_id !== group_id) {
    return new Response(
      JSON.stringify({ error: 'Invalid or expired invite token' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (inviteData.expires_at && inviteData.expires_at < now) {
    await deleteInviteToken(env, invite_token);
    return new Response(
      JSON.stringify({ error: 'Invite token expired' }),
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

  // Already a member?
  const alreadyMember = group.members.some((m) => m.clawid === clawid);
  if (alreadyMember) {
    return new Response(
      JSON.stringify({ error: 'Already a member of this group' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Max members
  if (group.members.length >= (group.policy.max_members || 20)) {
    return new Response(
      JSON.stringify({ error: 'Group is full' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // New member pubkey from registry
  const record = await getRegistry(env, clawid);
  if (!record) {
    return new Response(
      JSON.stringify({ error: 'ClawID not registered' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  group.members.push({ clawid, pubkey: record.pubkey });
  await setGroup(env, group_id, group);
  await deleteInviteToken(env, invite_token);

  return new Response(JSON.stringify({ ok: true, group_id, clawid }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
  });
}
