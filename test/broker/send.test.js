import { describe, it, expect, beforeEach } from 'vitest';
import { handleSend } from '../../broker/src/routes/send.js';
import { createMockEnv, makeRequest, registerClaw } from './helpers.js';

describe('POST /send', () => {
  let env;
  let tokenA;
  let tokenB;

  beforeEach(async () => {
    env = createMockEnv();
    tokenA = await registerClaw(env, 'sender-a');
    tokenB = await registerClaw(env, 'receiver-b');
  });

  it('returns msg_id on success', async () => {
    const req = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'encrypted-payload',
        client_msg_id: 'msg-001',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    const res = await handleSend(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.msg_id).toBeTruthy();
  });

  it('returns 404 when recipient missing', async () => {
    const req = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'nonexistent',
        data: 'x',
        client_msg_id: 'msg-002',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    const res = await handleSend(req, env);
    expect(res.status).toBe(404);
  });

  it('returns 403 when from mismatches token', async () => {
    const req = makeRequest(
      'POST',
      '/send',
      {
        from: 'receiver-b',
        to: 'sender-a',
        data: 'x',
        client_msg_id: 'msg-003',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    const res = await handleSend(req, env);
    expect(res.status).toBe(403);
  });

  it('returns 409 for duplicate client_msg_id', async () => {
    const body = {
      from: 'sender-a',
      to: 'receiver-b',
      data: 'x',
      client_msg_id: 'dup-msg-001',
      timestamp: Math.floor(Date.now() / 1000),
    };
    const req1 = makeRequest('POST', '/send', body, { Authorization: `Bearer ${tokenA}` });
    const res1 = await handleSend(req1, env);
    expect(res1.status).toBe(200);

    const req2 = makeRequest('POST', '/send', body, { Authorization: `Bearer ${tokenA}` });
    const res2 = await handleSend(req2, env);
    expect(res2.status).toBe(409);
  });

  it('returns 429 when same pair sends twice within cooldown', async () => {
    const makeBody = (id) => ({
      from: 'sender-a',
      to: 'receiver-b',
      data: 'x',
      client_msg_id: id,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const req1 = makeRequest('POST', '/send', makeBody('rate-msg-001'), { Authorization: `Bearer ${tokenA}` });
    const res1 = await handleSend(req1, env);
    expect(res1.status).toBe(200);

    const req2 = makeRequest('POST', '/send', makeBody('rate-msg-002'), { Authorization: `Bearer ${tokenA}` });
    const res2 = await handleSend(req2, env);
    expect(res2.status).toBe(429);
  });

  it('returns 401 without token', async () => {
    const req = makeRequest('POST', '/send', {
      from: 'sender-a',
      to: 'receiver-b',
      data: 'x',
      client_msg_id: 'msg-noauth',
      timestamp: Math.floor(Date.now() / 1000),
    });
    const res = await handleSend(req, env);
    expect(res.status).toBe(401);
  });

  it('returns 403 when recipient allowlist excludes sender', async () => {
    const { handleAllowlist } = await import('../../broker/src/routes/allowlist.js');
    // receiver-b sets allowlist to only allow 'other-claw'
    const alReq = makeRequest(
      'POST',
      '/allowlist',
      { action: 'add', clawid: 'other-claw' },
      { Authorization: `Bearer ${tokenB}` }
    );
    await handleAllowlist(alReq, env);
    // Mark allowlist as configured (non-null) by setting it in KV directly
    const { setAllowlist } = await import('../../broker/src/lib/kv.js');
    await setAllowlist(env, 'receiver-b', ['other-claw']);

    const req = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'x',
        client_msg_id: 'msg-blocked',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    const res = await handleSend(req, env);
    expect(res.status).toBe(403);
  });
});
