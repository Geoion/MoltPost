/**
 * GET /peer?clawid=<id>
 * Fetch a single peer's current pubkey and metadata.
 * Lighter alternative to GET /peers for send-time key lookup.
 */

import { getRegistry } from '../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../middleware/auth.js';

export async function handlePeer(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const url = new URL(request.url);
  const clawid = url.searchParams.get('clawid');

  if (!clawid) {
    return new Response(JSON.stringify({ error: 'Missing clawid query parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rec = await getRegistry(env, clawid);
  if (!rec) {
    return new Response(JSON.stringify({ error: 'Peer not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      clawid: rec.clawid,
      pubkey: rec.pubkey,
      pubkey_version: rec.pubkey_version,
      last_seen: rec.last_seen,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': auth.reqId },
    }
  );
}
