import { describe, it, expect, beforeEach } from 'vitest';
import { handleAllowlist } from '../../broker/src/routes/allowlist.js';
import { handleSend } from '../../broker/src/routes/send.js';
import { createMockEnv, makeRequest, registerClaw } from './helpers.js';

describe('Allowlist', () => {
  let env;
  let tokenA;
  let tokenB;

  beforeEach(async () => {
    env = createMockEnv();
    tokenA = await registerClaw(env, 'sender-a');
    tokenB = await registerClaw(env, 'receiver-b');
  });

  it('GET /allowlist starts empty', async () => {
    const req = makeRequest('GET', '/allowlist', null, { Authorization: `Bearer ${tokenB}` });
    const res = await handleAllowlist(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.allowlist).toEqual([]);
  });

  it('POST /allowlist add appends member', async () => {
    const req = makeRequest(
      'POST',
      '/allowlist',
      { action: 'add', clawid: 'sender-a' },
      { Authorization: `Bearer ${tokenB}` }
    );
    const res = await handleAllowlist(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.allowlist).toContain('sender-a');
  });

  it('POST /allowlist remove drops member', async () => {
    // Add first
    const addReq = makeRequest(
      'POST',
      '/allowlist',
      { action: 'add', clawid: 'sender-a' },
      { Authorization: `Bearer ${tokenB}` }
    );
    await handleAllowlist(addReq, env);

    // Remove
    const removeReq = makeRequest(
      'POST',
      '/allowlist',
      { action: 'remove', clawid: 'sender-a' },
      { Authorization: `Bearer ${tokenB}` }
    );
    const res = await handleAllowlist(removeReq, env);
    const data = await res.json();
    expect(data.allowlist).not.toContain('sender-a');
  });

  it('blocks send (403) when sender not on allowlist', async () => {
    // Set allowlist to only allow 'other-claw'
    const { setAllowlist } = await import('../../broker/src/lib/kv.js');
    await setAllowlist(env, 'receiver-b', ['other-claw']);

    const sendReq = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'blocked',
        client_msg_id: 'blocked-msg-001',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    const res = await handleSend(sendReq, env);
    expect(res.status).toBe(403);
  });

  it('allows send when sender is on allowlist', async () => {
    const { setAllowlist } = await import('../../broker/src/lib/kv.js');
    await setAllowlist(env, 'receiver-b', ['sender-a']);

    const sendReq = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'allowed',
        client_msg_id: 'allowed-msg-001',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    const res = await handleSend(sendReq, env);
    expect(res.status).toBe(200);
  });

  it('accepts all senders when allowlist not configured', async () => {
    const sendReq = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'open',
        client_msg_id: 'open-msg-001',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    const res = await handleSend(sendReq, env);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid action', async () => {
    const req = makeRequest(
      'POST',
      '/allowlist',
      { action: 'invalid', clawid: 'sender-a' },
      { Authorization: `Bearer ${tokenB}` }
    );
    const res = await handleAllowlist(req, env);
    expect(res.status).toBe(400);
  });
});
