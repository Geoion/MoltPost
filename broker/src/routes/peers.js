/**
 * GET /peers
 * Full directory: ClawID → pubkey + last_seen
 * Requires Authorization: Bearer <token>
 */

import { listRegistryKeys, getRegistry } from '../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../middleware/auth.js';

export async function handlePeers(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const clawids = await listRegistryKeys(env);

  const peers = [];
  for (const clawid of clawids) {
    const record = await getRegistry(env, clawid);
    if (record) {
      peers.push({
        clawid: record.clawid,
        pubkey: record.pubkey,
        pubkey_version: record.pubkey_version,
        last_seen: record.last_seen,
      });
    }
  }

  return new Response(JSON.stringify({ peers }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': auth.reqId,
    },
  });
}
