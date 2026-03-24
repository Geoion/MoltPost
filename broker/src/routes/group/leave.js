/**
 * POST /group/leave
 * Leave group or remove member (owner may remove others)
 */

import { getGroup, setGroup, deleteGroup } from '../../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../../middleware/auth.js';

export async function handleGroupLeave(request, env) {
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

  const { group_id, clawid: bodyClawid, operator_clawid } = body;
  const clawid = bodyClawid || auth.clawid;

  if (!group_id) {
    return new Response(
      JSON.stringify({ error: 'Missing group_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const group = await getGroup(env, group_id);
  if (!group) {
    return new Response(JSON.stringify({ error: `Group not found: ${group_id}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const operator = operator_clawid || auth.clawid;

  // Self-leave or owner removes others
  if (operator !== clawid && operator !== group.owner_clawid) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: only owner can remove other members' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // operator must match bearer identity
  if (auth.clawid !== operator) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: operator does not match authenticated clawid' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const memberExists = group.members.some((m) => m.clawid === clawid);
  if (!memberExists) {
    return new Response(
      JSON.stringify({ error: 'Member not found in group' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Owner leaving dissolves the group
  if (clawid === group.owner_clawid) {
    await deleteGroup(env, group_id);
    return new Response(
      JSON.stringify({ ok: true, action: 'group_dissolved', group_id }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId } }
    );
  }

  group.members = group.members.filter((m) => m.clawid !== clawid);
  await setGroup(env, group_id, group);

  return new Response(JSON.stringify({ ok: true, group_id, removed: clawid }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
  });
}
