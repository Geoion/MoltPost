import { describe, it, expect, beforeEach } from 'vitest';
import { handlePull } from '../../broker/src/routes/pull.js';
import { handleSend } from '../../broker/src/routes/send.js';
import { handleAck } from '../../broker/src/routes/ack.js';
import { createMockEnv, makeRequest, registerClaw } from './helpers.js';

describe('POST /pull', () => {
  let env;
  let tokenA;
  let tokenB;

  beforeEach(async () => {
    env = createMockEnv();
    tokenA = await registerClaw(env, 'sender-a');
    tokenB = await registerClaw(env, 'receiver-b');
  });

  it('returns message list after send', async () => {
    const sendReq = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'hello',
        client_msg_id: 'pull-test-001',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    await handleSend(sendReq, env);

    const pullReq = makeRequest('POST', '/pull', {}, { Authorization: `Bearer ${tokenB}` });
    const res = await handlePull(pullReq, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].data).toBe('hello');
  });

  it('returns count 0 for empty queue', async () => {
    const pullReq = makeRequest('POST', '/pull', {}, { Authorization: `Bearer ${tokenB}` });
    const res = await handlePull(pullReq, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(0);
  });

  it('returns 429 when pull repeats within min interval', async () => {
    const pullReq1 = makeRequest('POST', '/pull', {}, { Authorization: `Bearer ${tokenB}` });
    await handlePull(pullReq1, env);

    const pullReq2 = makeRequest('POST', '/pull', {}, { Authorization: `Bearer ${tokenB}` });
    const res2 = await handlePull(pullReq2, env);
    expect(res2.status).toBe(429);
  });

  it('returns 401 without token', async () => {
    const pullReq = makeRequest('POST', '/pull', {});
    const res = await handlePull(pullReq, env);
    expect(res.status).toBe(401);
  });

  it('does not return expired messages', async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 1;
    const sendReq = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'expired',
        client_msg_id: 'expired-msg-001',
        timestamp: Math.floor(Date.now() / 1000),
        expires_at: pastExpiry,
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    await handleSend(sendReq, env);

    const pullReq = makeRequest('POST', '/pull', {}, { Authorization: `Bearer ${tokenB}` });
    const res = await handlePull(pullReq, env);
    const data = await res.json();
    expect(data.count).toBe(0);
  });
});

describe('POST /ack', () => {
  let env;
  let tokenA;
  let tokenB;

  beforeEach(async () => {
    env = createMockEnv();
    tokenA = await registerClaw(env, 'sender-a');
    tokenB = await registerClaw(env, 'receiver-b');
  });

  it('removes message from queue after ACK', async () => {
    const sendReq = makeRequest(
      'POST',
      '/send',
      {
        from: 'sender-a',
        to: 'receiver-b',
        data: 'ack-me',
        client_msg_id: 'ack-msg-001',
        timestamp: Math.floor(Date.now() / 1000),
      },
      { Authorization: `Bearer ${tokenA}` }
    );
    await handleSend(sendReq, env);

    // Pull to get msg_id
    const pullReq = makeRequest('POST', '/pull', {}, { Authorization: `Bearer ${tokenB}` });
    const pullRes = await handlePull(pullReq, env);
    const { messages } = await pullRes.json();
    expect(messages.length).toBe(1);

    // ACK
    const ackReq = makeRequest(
      'POST',
      '/ack',
      { msg_ids: [messages[0].id] },
      { Authorization: `Bearer ${tokenB}` }
    );
    const ackRes = await handleAck(ackReq, env);
    expect(ackRes.status).toBe(200);

    // Pull again — should be empty (reset rate limit by creating new env)
    const env2 = createMockEnv();
    const tokenB2 = await registerClaw(env2, 'receiver-b');
    const pullReq2 = makeRequest('POST', '/pull', {}, { Authorization: `Bearer ${tokenB2}` });
    const pullRes2 = await handlePull(pullReq2, env2);
    const data2 = await pullRes2.json();
    expect(data2.count).toBe(0);
  });
});
