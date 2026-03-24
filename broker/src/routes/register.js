/**
 * POST /register
 * Register ClawID + pubkey, issue access_token
 * --force (X-Force-Register) re-registers and revokes the old token
 */

import { getRegistry, setRegistry, setTokenIndex, deleteTokenIndex, getGroup, setGroup, appendPubkeyHistory } from '../lib/kv.js';
import { auditRegister } from '../lib/audit.js';
import { authenticate } from '../middleware/auth.js';
import { verifyStringSignature } from '../lib/crypto.js';

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateMsgId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function handleRegister(request, env) {
  const reqId = request.headers.get('X-Request-Id') || crypto.randomUUID();

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { clawid, pubkey, group_name } = body;

  if (!clawid || typeof clawid !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(clawid)) {
    return new Response(
      JSON.stringify({ error: 'Invalid clawid: must be 1-64 alphanumeric/underscore/hyphen characters' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!pubkey || typeof pubkey !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing pubkey' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const existing = await getRegistry(env, clawid);
  const isForce = request.headers.get('X-Force-Register') === 'true';

  if (existing && !isForce) {
    // Valid token required for force path
    const auth = await authenticate(request, env);
    if (!auth || auth.clawid !== clawid) {
      return new Response(
        JSON.stringify({ error: 'ClawID already registered. Use --force with valid token to override.' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Valid token but missing force header
    return new Response(
      JSON.stringify({ error: 'ClawID already registered. Use --force to override.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (existing && isForce) {
    // Primary: verify via existing access_token
    const auth = await authenticate(request, env);
    const tokenValid = auth && auth.clawid === clawid;

    // Fallback: verify via pubkey signature when token is stale/lost
    // Client sends: X-Force-Challenge: "<clawid>|reregister|<ts>"
    //               X-Force-Signature: <hex RSA-PSS sig of challenge>
    let sigValid = false;
    if (!tokenValid) {
      const challenge = request.headers.get('X-Force-Challenge');
      const signature = request.headers.get('X-Force-Signature');
      if (challenge && signature) {
        const parts = challenge.split('|');
        const challengeTs = parseInt(parts[2], 10);
        const now2 = Math.floor(Date.now() / 1000);
        const fresh = parts.length === 3 && parts[0] === clawid && parts[1] === 'reregister'
          && !isNaN(challengeTs) && Math.abs(now2 - challengeTs) <= 300;
        if (fresh) {
          sigValid = await verifyStringSignature(existing.pubkey, challenge, signature);
        }
      }
    }

    if (!tokenValid && !sigValid) {
      return new Response(
        JSON.stringify({ error: 'Force register requires valid access_token or pubkey signature' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Keep old pubkey in history for rotation / old ciphertext
    await appendPubkeyHistory(env, clawid, existing.pubkey, existing.pubkey_version || 1);
    // Revoke old token index
    await deleteTokenIndex(env, existing.access_token);
  }

  const accessToken = generateToken();
  const now = Math.floor(Date.now() / 1000);

  const registryData = {
    clawid,
    pubkey,
    pubkey_version: existing ? (existing.pubkey_version || 0) + 1 : 1,
    access_token: accessToken,
    last_seen: now,
    created_at: existing ? existing.created_at : now,
    group_name: group_name || null,
  };

  await setRegistry(env, clawid, registryData);
  await setTokenIndex(env, accessToken, clawid);

  // Optional group_name creates ClawGroup with owner = clawid
  if (group_name && typeof group_name === 'string') {
    const existingGroup = await getGroup(env, group_name);
    if (!existingGroup) {
      const groupData = {
        group_id: group_name,
        owner_clawid: clawid,
        members: [{ clawid, pubkey }],
        policy: {
          send_policy: 'owner_only',
          max_members: 20,
        },
        created_at: now,
      };
      await setGroup(env, group_name, groupData);
    }
  }

  auditRegister(clawid, reqId, !!existing && isForce);

  return new Response(JSON.stringify({ access_token: accessToken }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
  });
}
