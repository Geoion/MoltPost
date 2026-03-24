/**
 * GET /allowlist  — list allowed senders for this ClawID
 * POST /allowlist — add/remove allowlist entries
 */

import { getAllowlist, setAllowlist } from '../lib/kv.js';
import { authenticate, unauthorizedResponse } from '../middleware/auth.js';

export async function handleAllowlist(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const clawid = auth.clawid;
  const reqId = auth.reqId;

  if (request.method === 'GET') {
    const list = await getAllowlist(env, clawid);
    return new Response(JSON.stringify({ allowed: list || [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
    });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Batch set: { allowed: [...] }
    if (Array.isArray(body.allowed)) {
      await setAllowlist(env, clawid, body.allowed);
      return new Response(JSON.stringify({ ok: true, allowed: body.allowed }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
      });
    }

    // Single add/remove: { action, clawid }
    const { action, clawid: targetClawid } = body;

    if (!action || !targetClawid) {
      return new Response(JSON.stringify({ error: 'Missing action or clawid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (action !== 'add' && action !== 'remove') {
      return new Response(JSON.stringify({ error: 'action must be "add" or "remove"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let list = (await getAllowlist(env, clawid)) || [];

    if (action === 'add') {
      if (!list.includes(targetClawid)) {
        list.push(targetClawid);
      }
    } else {
      list = list.filter((id) => id !== targetClawid);
    }

    await setAllowlist(env, clawid, list);

    return new Response(JSON.stringify({ ok: true, allowed: list }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
    });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
