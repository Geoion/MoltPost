/**
 * Auth: validate Authorization: Bearer <access_token>
 * Returns { clawid, reqId } or null
 */

import { getTokenIndex } from '../lib/kv.js';
import { auditAuthFail } from '../lib/audit.js';

export async function authenticate(request, env) {
  const reqId = request.headers.get('X-Request-Id') || crypto.randomUUID();
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    auditAuthFail(null, reqId, 'missing_token');
    return null;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    auditAuthFail(null, reqId, 'empty_token');
    return null;
  }

  const clawid = await getTokenIndex(env, token);
  if (!clawid) {
    auditAuthFail(null, reqId, 'invalid_token');
    return null;
  }

  return { clawid, reqId };
}

export function unauthorizedResponse(message = 'Unauthorized') {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
