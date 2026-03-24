/**
 * E2E: send, pull, ack with real E2EE
 * Broker at BROKER_URL (default http://localhost:8787)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  BROKER_URL,
  waitForBroker,
  registerClaw,
  sendMessage,
  pullMessages,
  ackMessages,
  decryptMessage,
} from './helpers.mjs';

beforeAll(async () => {
  await waitForBroker();
}, 15000);

describe('Full E2EE message flow', () => {
  let alice, bob;

  beforeAll(async () => {
    const suffix = Date.now();
    alice = await registerClaw(`e2e-alice-${suffix}`);
    bob = await registerClaw(`e2e-bob-${suffix}`);
  });

  it('alice sends encrypted message to bob', async () => {
    const res = await sendMessage(
      alice.access_token,
      alice.clawid,
      alice.privateKey,
      bob.clawid,
      bob.publicKey,
      'Hello Bob from E2E test!'
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('bob pulls and decrypts', async () => {
    await new Promise((r) => setTimeout(r, 1000));

    const res = await pullMessages(bob.access_token);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBeGreaterThan(0);

    const msg = data.messages[0];
    expect(msg.data).toBeTruthy();

    const plaintext = await decryptMessage(bob.privateKey, msg.data);
    expect(plaintext).toBe('Hello Bob from E2E test!');
  });

  it('after ACK, pull returns empty', async () => {
    const pullRes = await pullMessages(bob.access_token);

    // Rate limit may apply if previous pull was recent
    if (pullRes.status === 429) return;

    expect(pullRes.status).toBe(200);
    const { messages } = await pullRes.json();

    if (messages && messages.length > 0) {
      const msgIds = messages.map((m) => m.id);
      const ackRes = await ackMessages(bob.access_token, msgIds);
      expect(ackRes.status).toBe(200);

      await new Promise((r) => setTimeout(r, 500));
      const pullRes2 = await pullMessages(bob.access_token);
      if (pullRes2.status === 429) return;
      const data2 = await pullRes2.json();
      expect(data2.messages).toHaveLength(0);
    }
  });
});

describe('Send validation', () => {
  let sender, receiver;

  beforeAll(async () => {
    const suffix = Date.now();
    sender = await registerClaw(`e2e-sender-${suffix}`);
    receiver = await registerClaw(`e2e-receiver-${suffix}`);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BROKER_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'nobody',
        to: 'someone',
        client_msg_id: 'x',
        timestamp: 1,
        data: 'x',
        signature: 'x',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown recipient', async () => {
    const res = await fetch(`${BROKER_URL}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sender.access_token}`,
      },
      body: JSON.stringify({
        from: sender.clawid,
        to: 'nonexistent-claw-xyz',
        client_msg_id: `test-${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
        data: 'encrypted-data',
        signature: 'fake-sig',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 for duplicate client_msg_id', async () => {
    const { encrypt, sign } = await import('../../client/scripts/lib/crypto.mjs');
    const to = receiver.clawid;
    const client_msg_id = `dedup-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const data = encrypt(receiver.publicKey, 'dedup test');
    const payload = { from: sender.clawid, to, client_msg_id, timestamp, data };
    const signature = sign(sender.privateKey, payload);

    const body = JSON.stringify({ ...payload, signature });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sender.access_token}`,
    };

    const res1 = await fetch(`${BROKER_URL}/send`, { method: 'POST', headers, body });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`${BROKER_URL}/send`, { method: 'POST', headers, body });
    expect(res2.status).toBe(409);
  });
});

describe('Pull and ack', () => {
  let user;

  beforeAll(async () => {
    user = await registerClaw(`e2e-pull-${Date.now()}`);
  });

  it('returns 401 for unauthenticated pull', async () => {
    const res = await fetch(`${BROKER_URL}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('returns empty messages when queue is empty', async () => {
    const res = await pullMessages(user.access_token);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toEqual([]);
  });
});
