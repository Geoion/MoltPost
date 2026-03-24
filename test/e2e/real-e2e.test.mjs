/**
 * Real E2E tests — runs against the deployed Cloudflare broker.
 *
 * Usage:
 *   BROKER_URL=https://moltpost-broker.404cloud.win npx vitest run --config test/vitest.real-e2e.config.js
 *
 * Or via package.json script:
 *   cd broker && npm run test:real-e2e
 *
 * The BROKER_URL env var must point to the live CF worker.
 * Tests use unique timestamped ClawIDs so they are safe to run repeatedly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, encrypt, sign, decrypt } from '../../client/scripts/lib/crypto.mjs';

const BROKER_URL = process.env.BROKER_URL;

if (!BROKER_URL) {
  throw new Error(
    'BROKER_URL env var is required.\n' +
    'Example: BROKER_URL=https://moltpost-broker.404cloud.win npm run test:real-e2e'
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** fetch with automatic retry on transient socket/TLS errors */
async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function apiRegister(clawid, pubkey, headers = {}) {
  const res = await fetchWithRetry(`${BROKER_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ clawid, pubkey }),
  });
  return { status: res.status, data: await res.json() };
}

async function apiSend(token, payload) {
  const res = await fetchWithRetry(`${BROKER_URL}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, data: await res.json() };
}

async function apiPull(token) {
  const res = await fetchWithRetry(`${BROKER_URL}/pull`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  return { status: res.status, data: await res.json() };
}

async function apiAck(token, msgIds) {
  const res = await fetchWithRetry(`${BROKER_URL}/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ msg_ids: msgIds }),
  });
  return { status: res.status, data: await res.json() };
}

/** Register a new ClawID with a fresh RSA key pair */
async function registerFresh(prefix) {
  const clawid = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const kp = generateKeyPair();
  const { status, data } = await apiRegister(clawid, kp.publicKey);
  if (status !== 200) throw new Error(`Register failed [${status}]: ${JSON.stringify(data)}`);
  return { clawid, token: data.access_token, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Build a properly signed send payload */
function buildSignedPayload(fromClawid, fromPrivKey, toClawid, toPubkey, text) {
  const client_msg_id = `cmid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const data = encrypt(toPubkey, text);
  const payload = { from: fromClawid, to: toClawid, client_msg_id, timestamp, data };
  const signature = sign(fromPrivKey, payload);
  return { ...payload, signature };
}

/** Poll /pull until at least one message arrives or timeout */
async function pollPull(token, timeoutMs = 10000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, data } = await apiPull(token);
    if (status === 200 && data.messages && data.messages.length > 0) {
      return { status, data };
    }
    if (status !== 429 && status !== 200) {
      return { status, data };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 200, data: { messages: [], count: 0 } };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('CF Broker — discovery', () => {
  it('GET /.well-known/moltpost returns broker info', async () => {
    const res = await fetch(`${BROKER_URL}/.well-known/moltpost`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version).toBe('1.0');
    expect(data.broker).toBe('moltpost-broker');
    expect(Array.isArray(data.encryption)).toBe(true);
    expect(data.encryption.length).toBeGreaterThan(0);
    expect(data.api_versions).toContain('v1');
  });
});

describe('CF Broker — register', () => {
  it('registers a new ClawID and returns access_token', async () => {
    const clawid = `real-reg-${Date.now()}`;
    const kp = generateKeyPair();
    const { status, data } = await apiRegister(clawid, kp.publicKey);
    expect(status).toBe(200);
    expect(typeof data.access_token).toBe('string');
    expect(data.access_token.length).toBeGreaterThan(10);
    // access_token must be usable immediately — verify by pulling
    const { status: pullStatus, data: pullData } = await apiPull(data.access_token);
    expect(pullStatus).toBe(200);
    expect(Array.isArray(pullData.messages)).toBe(true);
  });

  it('returns 409 when ClawID already exists (no force)', async () => {
    const clawid = `real-dup-${Date.now()}`;
    const kp = generateKeyPair();
    const first = await apiRegister(clawid, kp.publicKey);
    expect(first.status).toBe(200);

    const second = await apiRegister(clawid, kp.publicKey);
    expect(second.status).toBe(409);
    expect(second.data.error).toMatch(/already|exists|registered/i);
  });

  it('force re-register replaces pubkey and issues new token', async () => {
    const user = await registerFresh('real-force');
    const kp2 = generateKeyPair();
    const { status, data } = await apiRegister(user.clawid, kp2.publicKey, {
      Authorization: `Bearer ${user.token}`,
      'X-Force-Register': 'true',
    });
    expect(status).toBe(200);
    expect(typeof data.access_token).toBe('string');
    // New token must differ from old
    expect(data.access_token).not.toBe(user.token);
    // Verify new pubkey is stored: /peer must return kp2.publicKey
    const peerRes = await fetch(`${BROKER_URL}/peer?clawid=${encodeURIComponent(user.clawid)}`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    expect(peerRes.status).toBe(200);
    const peerData = await peerRes.json();
    expect(peerData.pubkey).toBe(kp2.publicKey);
    expect(peerData.pubkey).not.toBe(user.publicKey);
  });

  it('returns 400 for missing pubkey and includes error message', async () => {
    const res = await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clawid: `real-nopub-${Date.now()}` }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
    expect(data.error.length).toBeGreaterThan(0);
  });

  it('returns 400 for missing clawid', async () => {
    const kp = generateKeyPair();
    const res = await fetch(`${BROKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: kp.publicKey }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });
});

describe('CF Broker — send & pull (full E2EE flow)', () => {
  let alice, bob;
  let sentMsgId;

  beforeAll(async () => {
    alice = await registerFresh('real-alice');
    bob = await registerFresh('real-bob');
  }, 20000);

  it('alice sends encrypted message to bob; response includes msg_id', async () => {
    const payload = buildSignedPayload(alice.clawid, alice.privateKey, bob.clawid, bob.publicKey, 'Hello Bob!');
    const { status, data } = await apiSend(alice.token, payload);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.msg_id).toBe('string');
    expect(data.msg_id).toMatch(/^msg_/);
    sentMsgId = data.msg_id;
  });

  it('bob pulls: message has correct from/to/data fields and decrypts correctly', async () => {
    await new Promise((r) => setTimeout(r, 1500));

    const { status, data } = await pollPull(bob.token, 15000, 2000);
    expect(status).toBe(200);
    expect(Array.isArray(data.messages)).toBe(true);
    expect(typeof data.count).toBe('number');
    expect(data.messages.length).toBeGreaterThan(0);

    const msg = data.messages.find((m) => m.from === alice.clawid);
    expect(msg).toBeDefined();
    expect(msg.to).toBe(bob.clawid);
    expect(typeof msg.id).toBe('string');
    expect(typeof msg.data).toBe('string');
    expect(typeof msg.timestamp).toBe('number');
    expect(msg.client_msg_id).toMatch(/^cmid-/);

    // Decrypt and verify plaintext
    const plaintext = decrypt(bob.privateKey, msg.data);
    expect(plaintext).toBe('Hello Bob!');
  });

  it('bob acks messages; subsequent pull returns empty inbox', async () => {
    const { status: s1, data: d1 } = await pollPull(bob.token, 10000, 1500);
    expect(s1).toBe(200);
    expect(Array.isArray(d1.messages)).toBe(true);

    if (d1.messages.length > 0) {
      const msgIds = d1.messages.map((m) => m.id);
      const { status: ackStatus, data: ackData } = await apiAck(bob.token, msgIds);
      expect(ackStatus).toBe(200);
      expect(ackData.acked).toBe(msgIds.length);

      await new Promise((r) => setTimeout(r, 1000));
      const { status: s2, data: d2 } = await pollPull(bob.token, 8000, 1500);
      expect(s2).toBe(200);
      expect(d2.messages).toHaveLength(0);
      expect(d2.count).toBe(0);
    }
  });

  it('send with wrong from (mismatched token) returns 403 with error', async () => {
    const payload = buildSignedPayload(bob.clawid, bob.privateKey, alice.clawid, alice.publicKey, 'spoof');
    // Use alice's token but bob's clawid as from
    const { status, data } = await apiSend(alice.token, { ...payload, from: bob.clawid });
    expect(status).toBe(403);
    expect(data.error).toMatch(/forbidden|mismatch/i);
  });
});

describe('CF Broker — dedup (409)', () => {
  let sender, receiver;

  beforeAll(async () => {
    sender = await registerFresh('real-dedup-s');
    receiver = await registerFresh('real-dedup-r');
  }, 20000);

  it('second send with same client_msg_id returns 409 with duplicate error', async () => {
    const payload = buildSignedPayload(
      sender.clawid, sender.privateKey,
      receiver.clawid, receiver.publicKey,
      'dedup test message'
    );

    const { status: s1, data: d1 } = await apiSend(sender.token, payload);
    expect(s1).toBe(200);
    expect(d1.ok).toBe(true);

    const { status: s2, data: d2 } = await apiSend(sender.token, payload);
    expect(s2).toBe(409);
    expect(d2.error).toMatch(/duplicate/i);
    expect(d2.client_msg_id).toBe(payload.client_msg_id);
  });

  it('different client_msg_id after rate limit window succeeds', async () => {
    const deadline = Date.now() + 15000;
    let lastStatus = 429;
    let lastData;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const payload2 = buildSignedPayload(
        sender.clawid, sender.privateKey,
        receiver.clawid, receiver.publicKey,
        `second-distinct-${Date.now()}`
      );
      const { status, data } = await apiSend(sender.token, payload2);
      lastStatus = status;
      lastData = data;
      if (status === 200) break;
    }
    expect(lastStatus).toBe(200);
    expect(lastData.ok).toBe(true);
    expect(typeof lastData.msg_id).toBe('string');
  });
});

describe('CF Broker — dedup fix: retry after failed send', () => {
  it('same client_msg_id succeeds after initial 404 failure (not blocked as duplicate)', async () => {
    const sender = await registerFresh('real-dedup-retry-s');
    const receiver = await registerFresh('real-dedup-retry-r');

    const client_msg_id = `cmid-retry-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const encryptedData = encrypt(receiver.publicKey, 'retry test');

    // First attempt: send to nonexistent recipient → 404
    const { status: s1, data: d1 } = await apiSend(sender.token, {
      from: sender.clawid,
      to: `nonexistent-${Date.now()}`,
      data: encryptedData,
      client_msg_id,
      timestamp,
    });
    expect(s1).toBe(404);
    expect(d1.error).toMatch(/not found/i);

    // Wait for rate limit to clear
    await new Promise((r) => setTimeout(r, 2000));

    // Retry with same client_msg_id but correct recipient → must succeed, not 409
    const { status: s2, data: d2 } = await apiSend(sender.token, {
      from: sender.clawid,
      to: receiver.clawid,
      data: encryptedData,
      client_msg_id,
      timestamp,
    });
    expect(s2).toBe(200);
    expect(d2.ok).toBe(true);
    expect(typeof d2.msg_id).toBe('string');

    // Verify message actually arrived
    const { data: pullData } = await pollPull(receiver.token, 10000, 2000);
    const msg = (pullData.messages || []).find((m) => m.client_msg_id === client_msg_id);
    expect(msg).toBeDefined();
    expect(decrypt(receiver.privateKey, msg.data)).toBe('retry test');
  });
});

describe('CF Broker — auth guards', () => {
  it('send without token returns 401 with error', async () => {
    const res = await fetch(`${BROKER_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'x', to: 'y', data: 'z', client_msg_id: 'x1', timestamp: 1 }),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });

  it('pull without token returns 401 with error', async () => {
    const res = await fetch(`${BROKER_URL}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });

  it('send to nonexistent recipient returns 404 with error', async () => {
    const user = await registerFresh('real-404-s');
    const { status, data } = await apiSend(user.token, {
      from: user.clawid,
      to: `nonexistent-${Date.now()}`,
      data: 'x',
      client_msg_id: `nc-${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    expect(status).toBe(404);
    expect(data.error).toMatch(/not found/i);
  });

  it('send with invalid token returns 401', async () => {
    const user = await registerFresh('real-badtoken');
    const payload = buildSignedPayload(user.clawid, user.privateKey, user.clawid, user.publicKey, 'x');
    const { status, data } = await apiSend('invalid-token-xyz', payload);
    expect(status).toBe(401);
    expect(typeof data.error).toBe('string');
  });
});

describe('CF Broker — /peer lookup', () => {
  it('returns correct clawid, pubkey, pubkey_version, last_seen for registered user', async () => {
    const user = await registerFresh('real-peer');
    const res = await fetch(`${BROKER_URL}/peer?clawid=${encodeURIComponent(user.clawid)}`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.clawid).toBe(user.clawid);
    expect(data.pubkey).toBe(user.publicKey);
    expect(typeof data.pubkey_version).toBe('number');
    expect(typeof data.last_seen).toBe('number');
  });

  it('returns 404 with error for unknown ClawID', async () => {
    const user = await registerFresh('real-peer-auth');
    const res = await fetch(`${BROKER_URL}/peer?clawid=nobody-${Date.now()}`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });

  it('user A can look up user B pubkey and it matches B\'s registered key', async () => {
    const userA = await registerFresh('real-peer-a');
    const userB = await registerFresh('real-peer-b');
    const res = await fetch(`${BROKER_URL}/peer?clawid=${encodeURIComponent(userB.clawid)}`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.clawid).toBe(userB.clawid);
    expect(data.pubkey).toBe(userB.publicKey);
    // Verify the returned pubkey can actually decrypt a message encrypted with it
    const ciphertext = encrypt(data.pubkey, 'test-verify');
    const plaintext = decrypt(userB.privateKey, ciphertext);
    expect(plaintext).toBe('test-verify');
  });

  it('returns 401 with error for /peer without token', async () => {
    const user = await registerFresh('real-peer-noauth');
    const res = await fetch(`${BROKER_URL}/peer?clawid=${encodeURIComponent(user.clawid)}`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });

  it('returns 400 with error when clawid param is missing', async () => {
    const user = await registerFresh('real-peer-noparam');
    const res = await fetch(`${BROKER_URL}/peer`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });
});

describe('CF Broker — /peers list', () => {
  it('GET /peers returns 200 with peers array', { timeout: 60000 }, async () => {
    const user = await registerFresh('real-peers-a');
    const res = await fetch(`${BROKER_URL}/peers`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.peers)).toBe(true);
  });

  it('each peer entry has required fields with correct types', async () => {
    const user = await registerFresh('real-peers-fields');
    const res = await fetch(`${BROKER_URL}/peers`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    for (const peer of data.peers) {
      expect(typeof peer.clawid).toBe('string');
      expect(peer.clawid.length).toBeGreaterThan(0);
      expect(typeof peer.pubkey).toBe('string');
      expect(peer.pubkey).toMatch(/BEGIN PUBLIC KEY/);
      expect(typeof peer.pubkey_version).toBe('number');
    }
  });

  it('GET /peers returns 401 without token', async () => {
    const res = await fetch(`${BROKER_URL}/peers`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });
});

describe('CF Broker — force re-register invalidates old token', () => {
  it('old token is rejected after force re-register; new token works', async () => {
    const user = await registerFresh('real-reregister');
    const oldToken = user.token;

    let status, data;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const kp2 = generateKeyPair();
        ({ status, data } = await apiRegister(user.clawid, kp2.publicKey, {
          Authorization: `Bearer ${oldToken}`,
          'X-Force-Register': 'true',
        }));
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    expect(status).toBe(200);
    expect(typeof data.access_token).toBe('string');
    const newToken = data.access_token;
    expect(newToken).not.toBe(oldToken);

    // Old token must be rejected
    const { status: oldPullStatus, data: oldPullData } = await apiPull(oldToken);
    expect(oldPullStatus).toBe(401);
    expect(typeof oldPullData.error).toBe('string');

    // New token must work and return valid pull response
    const { status: newPullStatus, data: newPullData } = await apiPull(newToken);
    expect(newPullStatus).toBe(200);
    expect(Array.isArray(newPullData.messages)).toBe(true);
  });
});

describe('CF Broker — allowlist', () => {
  let owner, allowed, blocked;

  beforeAll(async () => {
    owner = await registerFresh('real-al-owner');
    allowed = await registerFresh('real-al-allowed');
    blocked = await registerFresh('real-al-blocked');

    const res = await fetch(`${BROKER_URL}/allowlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ action: 'add', clawid: allowed.clawid }),
    });
    expect(res.status).toBe(200);
  }, 30000);

  it('allowed sender can send to owner; message is delivered and decryptable', async () => {
    const payload = buildSignedPayload(
      allowed.clawid, allowed.privateKey,
      owner.clawid, owner.publicKey,
      'hello from allowed'
    );
    const { status, data } = await apiSend(allowed.token, payload);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.msg_id).toBe('string');

    // Verify owner receives and can decrypt it
    const { data: pullData } = await pollPull(owner.token, 12000, 2000);
    const msg = (pullData.messages || []).find((m) => m.from === allowed.clawid);
    expect(msg).toBeDefined();
    expect(decrypt(owner.privateKey, msg.data)).toBe('hello from allowed');
  });

  it('blocked sender gets 403 with allowlist error; message is NOT delivered', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const payload = buildSignedPayload(
      blocked.clawid, blocked.privateKey,
      owner.clawid, owner.publicKey,
      'hello from blocked'
    );
    const { status, data } = await apiSend(blocked.token, payload);
    expect(status).toBe(403);
    expect(data.error).toMatch(/allowlist/i);

    // Verify owner does NOT receive this message
    await new Promise((r) => setTimeout(r, 2000));
    const { data: pullData } = await apiPull(owner.token);
    const blockedMsg = (pullData.messages || []).find((m) => m.from === blocked.clawid);
    expect(blockedMsg).toBeUndefined();
  });
});

describe('CF Broker — multi-user send', () => {
  it('three users send to one receiver sequentially; all messages delivered and decryptable', async () => {
    const [a, b, c, recv] = await Promise.all([
      registerFresh('real-multi-a'),
      registerFresh('real-multi-b'),
      registerFresh('real-multi-c'),
      registerFresh('real-multi-recv'),
    ]);

    await new Promise((r) => setTimeout(r, 3000));

    const r1 = await apiSend(a.token, buildSignedPayload(a.clawid, a.privateKey, recv.clawid, recv.publicKey, 'from A'));
    expect(r1.status).toBe(200);
    expect(r1.data.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));

    const r2 = await apiSend(b.token, buildSignedPayload(b.clawid, b.privateKey, recv.clawid, recv.publicKey, 'from B'));
    expect(r2.status).toBe(200);
    expect(r2.data.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));

    const r3 = await apiSend(c.token, buildSignedPayload(c.clawid, c.privateKey, recv.clawid, recv.publicKey, 'from C'));
    expect(r3.status).toBe(200);
    expect(r3.data.ok).toBe(true);

    // Collect all messages via multiple pulls
    const allMessages = [];
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const { status, data } = await apiPull(recv.token);
      if (status === 200 && data.messages?.length > 0) {
        allMessages.push(...data.messages);
        if (allMessages.length >= 3) break;
      }
    }

    expect(allMessages.length).toBeGreaterThanOrEqual(3);

    // Verify each message is from the right sender and decrypts correctly
    const fromA = allMessages.find((m) => m.from === a.clawid);
    const fromB = allMessages.find((m) => m.from === b.clawid);
    const fromC = allMessages.find((m) => m.from === c.clawid);

    expect(fromA).toBeDefined();
    expect(fromB).toBeDefined();
    expect(fromC).toBeDefined();

    expect(decrypt(recv.privateKey, fromA.data)).toBe('from A');
    expect(decrypt(recv.privateKey, fromB.data)).toBe('from B');
    expect(decrypt(recv.privateKey, fromC.data)).toBe('from C');
  });
}, 60000);

describe('CF Broker — message expiry (expires_at)', () => {
  it('expired message is not delivered on pull', async () => {
    const sender = await registerFresh('real-exp-s');
    const receiver = await registerFresh('real-exp-r');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      ...buildSignedPayload(sender.clawid, sender.privateKey, receiver.clawid, receiver.publicKey, 'expiring msg'),
      expires_at: now - 1,
    };

    const { status, data: sendData } = await apiSend(sender.token, payload);
    expect(status).toBe(200);
    expect(sendData.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 2000));
    const { status: ps, data: pd } = await apiPull(receiver.token);
    expect(ps).toBe(200);
    expect(Array.isArray(pd.messages)).toBe(true);
    const found = pd.messages.find((m) => m.from === sender.clawid);
    expect(found).toBeUndefined();
  });
});

describe('CF Broker — group flow', () => {
  let owner, memberA, memberB;
  let groupId;

  beforeAll(async () => {
    owner = await registerFresh('real-grp-owner');
    memberA = await registerFresh('real-grp-ma');
    memberB = await registerFresh('real-grp-mb');
    groupId = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }, 30000);

  it('owner creates group; response has correct group_id and owner', async () => {
    const res = await fetch(`${BROKER_URL}/group/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ group_id: groupId, policy: { send_policy: 'all_members' } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.group_id).toBe(groupId);
    expect(data.group.owner_clawid).toBe(owner.clawid);
    expect(data.group.policy.send_policy).toBe('all_members');
    expect(data.group.members.some((m) => m.clawid === owner.clawid)).toBe(true);
  });

  it('owner issues invite token; token is a non-empty string with expiry', async () => {
    const res = await fetch(`${BROKER_URL}/group/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ group_id: groupId }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.invite_token).toBe('string');
    expect(data.invite_token.length).toBeGreaterThan(10);
    expect(typeof data.expires_at).toBe('number');
    expect(data.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    owner._inviteToken = data.invite_token;
  });

  it('memberA joins with invite token; appears in group peers', async () => {
    const res = await fetch(`${BROKER_URL}/group/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberA.token}` },
      body: JSON.stringify({ group_id: groupId, invite_token: owner._inviteToken }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.group_id).toBe(groupId);

    // Verify memberA appears in group peers
    const peersRes = await fetch(`${BROKER_URL}/group/peers?group_id=${groupId}`, {
      headers: { Authorization: `Bearer ${memberA.token}` },
    });
    expect(peersRes.status).toBe(200);
    const peersData = await peersRes.json();
    expect(peersData.members.some((m) => m.clawid === memberA.clawid)).toBe(true);
    expect(peersData.members.some((m) => m.clawid === owner.clawid)).toBe(true);
  });

  it('invalid invite token returns 403', async () => {
    const outsider = await registerFresh('real-grp-bad-inv');
    const res = await fetch(`${BROKER_URL}/group/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({ group_id: groupId, invite_token: 'invalid-token-xyz' }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });

  it('owner issues second invite; memberB joins', async () => {
    const invRes = await fetch(`${BROKER_URL}/group/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ group_id: groupId }),
    });
    expect(invRes.status).toBe(200);
    const { invite_token } = await invRes.json();

    const res = await fetch(`${BROKER_URL}/group/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberB.token}` },
      body: JSON.stringify({ group_id: groupId, invite_token }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('owner broadcasts; delivered_to includes both members; memberA receives and decrypts', async () => {
    const client_msg_id = `grp-bc-${Date.now()}`;
    const plaintext = 'broadcast msg';
    // For broadcast we encrypt with memberA's key (in real usage each recipient gets their own copy)
    const encData = encrypt(memberA.publicKey, plaintext);

    const res = await fetch(`${BROKER_URL}/group/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        group_id: groupId,
        from: owner.clawid,
        mode: 'broadcast',
        data: encData,
        client_msg_id,
      }),
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.group_id).toBe(groupId);
    expect(d.mode).toBe('broadcast');
    expect(Array.isArray(d.delivered_to)).toBe(true);
    expect(d.delivered_to).toContain(memberA.clawid);
    expect(d.delivered_to).toContain(memberB.clawid);
    expect(d.delivered_to).not.toContain(owner.clawid);

    // memberA pulls and decrypts
    const { data: pullData } = await pollPull(memberA.token, 15000, 2000);
    const msg = (pullData.messages || []).find((m) => m.group_id === groupId && m.client_msg_id === client_msg_id);
    expect(msg).toBeDefined();
    expect(msg.from).toBe(owner.clawid);
    expect(msg.to).toBe(memberA.clawid);
    expect(decrypt(memberA.privateKey, msg.data)).toBe(plaintext);
  });

  it('non-member send returns 403 with error', async () => {
    const outsider = await registerFresh('real-grp-out');
    const res = await fetch(`${BROKER_URL}/group/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({
        group_id: groupId,
        from: outsider.clawid,
        mode: 'broadcast',
        data: 'x',
        client_msg_id: `grp-out-${Date.now()}`,
      }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });

  it('memberA leaves group; subsequent broadcast does not include memberA', { timeout: 90000 }, async () => {
    const leaveRes = await fetchWithRetry(`${BROKER_URL}/group/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberA.token}` },
      body: JSON.stringify({ group_id: groupId }),
    });
    expect(leaveRes.status).toBe(200);
    const leaveData = await leaveRes.json();
    expect(leaveData.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 2000));

    const client_msg_id = `grp-after-leave-${Date.now()}`;
    const res = await fetchWithRetry(`${BROKER_URL}/group/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({
        group_id: groupId,
        from: owner.clawid,
        mode: 'broadcast',
        data: encrypt(memberB.publicKey, 'after leave'),
        client_msg_id,
      }),
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.delivered_to).not.toContain(memberA.clawid);
    expect(d.delivered_to).toContain(memberB.clawid);
  });
}, 180000);
