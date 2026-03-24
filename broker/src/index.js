/**
 * MoltPost Broker — Cloudflare Worker entry and URL router
 */

import { handleRegister } from './routes/register.js';
import { handlePeers } from './routes/peers.js';
import { handlePeer } from './routes/peer.js';
import { handleSend } from './routes/send.js';
import { handlePull } from './routes/pull.js';
import { handleAck } from './routes/ack.js';
import { handleAllowlist } from './routes/allowlist.js';
import { handleGroupCreate } from './routes/group/create.js';
import { handleGroupJoin } from './routes/group/join.js';
import { handleGroupLeave } from './routes/group/leave.js';
import { handleGroupPeers } from './routes/group/peers.js';
import { handleGroupSend } from './routes/group/send.js';
import { handleGroupInvite } from './routes/group/invite.js';
import { handleQueueBatch } from './lib/queue.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id, X-Force-Register',
  };
}

function notFound() {
  return new Response(JSON.stringify({ error: 'Not Found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function methodNotAllowed() {
  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async queue(batch, env) {
    await handleQueueBatch(batch, env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Attach CORS + X-Request-Id to every response
    const reqId = request.headers.get('X-Request-Id') || crypto.randomUUID();
    const injectHeaders = (response) => {
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders()).forEach(([k, v]) => newHeaders.set(k, v));
      if (!newHeaders.has('X-Request-Id')) newHeaders.set('X-Request-Id', reqId);
      return new Response(response.body, { status: response.status, headers: newHeaders });
    };

    try {
      let response;

      if (path === '/register' && method === 'POST') {
        response = await handleRegister(request, env);
      } else if (path === '/peers' && method === 'GET') {
        response = await handlePeers(request, env);
      } else if (path === '/peer' && method === 'GET') {
        response = await handlePeer(request, env);
      } else if (path === '/send' && method === 'POST') {
        response = await handleSend(request, env);
      } else if (path === '/pull' && method === 'POST') {
        response = await handlePull(request, env);
      } else if (path === '/ack' && method === 'POST') {
        response = await handleAck(request, env);
      } else if (path === '/allowlist') {
        if (method === 'GET' || method === 'POST') {
          response = await handleAllowlist(request, env);
        } else {
          response = methodNotAllowed();
        }
      } else if (path === '/group/create' && method === 'POST') {
        response = await handleGroupCreate(request, env);
      } else if (path === '/group/join' && method === 'POST') {
        response = await handleGroupJoin(request, env);
      } else if (path === '/group/leave' && method === 'POST') {
        response = await handleGroupLeave(request, env);
      } else if (path === '/group/peers' && method === 'GET') {
        response = await handleGroupPeers(request, env);
      } else if (path === '/group/send' && method === 'POST') {
        response = await handleGroupSend(request, env);
      } else if (path === '/group/invite' && method === 'POST') {
        response = await handleGroupInvite(request, env);
      } else if (path === '/.well-known/moltpost' && method === 'GET') {
        response = new Response(
          JSON.stringify({
            version: '1.0',
            broker: 'moltpost-broker',
            api_versions: ['v1'],
            encryption: ['RSA-OAEP', 'ECDH-X25519-AES-GCM'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        response = notFound();
      }

      return injectHeaders(response);
    } catch (err) {
      console.error(JSON.stringify({ ts: Math.floor(Date.now() / 1000), op: 'error', message: err.message, stack: err.stack }));
      return injectHeaders(
        new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
  },
};
