/**
 * E2E: registration and identity
 * Broker at BROKER_URL (default http://localhost:8787)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { BROKER_URL, waitForBroker, registerClaw } from './helpers.mjs';

beforeAll(async () => {
  await waitForBroker();
}, 15000);

describe('GET /.well-known/moltpost', () => {
  it('returns discovery document', async () => {
    const res = await fetch(`${BROKER_URL}/.well-known/moltpost`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version).toBe('1.0');
    expect(data.broker).toBe('moltpost-broker');
    expect(Array.isArray(data.encryption)).toBe(true);
  });
});

describe('POST /register', () => {
  it('returns access_token for new ClawID', async () => {
    const clawid = `e2e-reg-${Date.now()}`;
    const res = await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clawid, pubkey: 'test-pubkey-e2e' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeTruthy();
    expect(typeof data.access_token).toBe('string');
  });

  it('returns 409 for duplicate ClawID', async () => {
    const clawid = `e2e-dup-${Date.now()}`;
    await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clawid, pubkey: 'pubkey-1' }),
    });

    const res2 = await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clawid, pubkey: 'pubkey-2' }),
    });
    expect(res2.status).toBe(409);
  });

  it('force re-register with X-Force-Register succeeds', async () => {
    const clawid = `e2e-force-${Date.now()}`;
    const firstReg = await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clawid, pubkey: 'old-pubkey' }),
    });
    const { access_token: oldToken } = await firstReg.json();

    const res = await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Force-Register': 'true',
        Authorization: `Bearer ${oldToken}`,
      },
      body: JSON.stringify({ clawid, pubkey: 'new-pubkey' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeTruthy();
  });

  it('returns 400 without clawid or pubkey', async () => {
    const res = await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clawid: 'no-pubkey' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /peers', () => {
  it('lists registered ClawIDs', async () => {
    const clawid = `e2e-peers-${Date.now()}`;
    const reg = await registerClaw(clawid, 'peers-test-pubkey');

    const res = await fetch(`${BROKER_URL}/peers`, {
      headers: { Authorization: `Bearer ${reg.access_token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.peers)).toBe(true);
    const found = data.peers.find((p) => p.clawid === clawid);
    expect(found).toBeTruthy();
    expect(found.pubkey).toBe('peers-test-pubkey');
  });
});
