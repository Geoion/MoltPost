/**
 * GET /group/peers?group_id=xxx
 * Members + pubkeys for a group
 */

import { getGroup } from '../../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../../middleware/auth.js';

export async function handleGroupPeers(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const reqId = auth.reqId;
  const url = new URL(request.url);
  const groupId = url.searchParams.get('group_id');

  if (!groupId) {
    return new Response(JSON.stringify({ error: 'Missing group_id query parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const group = await getGroup(env, groupId);
  if (!group) {
    return new Response(JSON.stringify({ error: `Group not found: ${groupId}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Members only
  const isMember = group.members.some((m) => m.clawid === auth.clawid);
  if (!isMember) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: not a member of this group' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      group_id: groupId,
      owner_clawid: group.owner_clawid,
      members: group.members,
      policy: group.policy,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId } }
  );
}
