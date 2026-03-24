/**
 * POST /group/create
 * Create a ClawGroup
 */

import { getGroup, setGroup, getRegistry } from '../../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../../middleware/auth.js';
import { auditGroupCreate } from '../../lib/audit.js';

export async function handleGroupCreate(request, env) {
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

  const { group_id, owner_clawid: bodyOwner, members = [], policy = {} } = body;
  const owner_clawid = bodyOwner || auth.clawid;

  if (!group_id || typeof group_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(group_id)) {
    return new Response(
      JSON.stringify({ error: 'Invalid group_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (auth.clawid !== owner_clawid) {
    return new Response(
      JSON.stringify({ error: 'owner_clawid must match authenticated clawid' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const existing = await getGroup(env, group_id);
  if (existing) {
    return new Response(
      JSON.stringify({ error: `Group already exists: ${group_id}` }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Owner registry record
  const ownerRecord = await getRegistry(env, owner_clawid);
  if (!ownerRecord) {
    return new Response(
      JSON.stringify({ error: 'Owner ClawID not registered' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Seed members (owner always included)
  const memberSet = new Map();
  memberSet.set(owner_clawid, { clawid: owner_clawid, pubkey: ownerRecord.pubkey });

  for (const clawid of members) {
    if (clawid === owner_clawid) continue;
    const record = await getRegistry(env, clawid);
    if (record) {
      memberSet.set(clawid, { clawid, pubkey: record.pubkey });
    }
  }

  const groupData = {
    group_id,
    owner_clawid,
    members: Array.from(memberSet.values()),
    policy: {
      send_policy: policy.send_policy || 'owner_only',
      max_members: policy.max_members || 20,
      allowed_clawids: policy.allowed_clawids || [],
    },
    created_at: Math.floor(Date.now() / 1000),
  };

  await setGroup(env, group_id, groupData);
  auditGroupCreate(group_id, owner_clawid, reqId);

  return new Response(JSON.stringify({ ok: true, group_id, group: groupData }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
  });
}
