/**
 * E2E test helpers
 * Requires a running Broker (default http://localhost:8787)
 */

export const BROKER_URL = process.env.BROKER_URL || 'http://localhost:8787';

/**
 * Poll until Broker responds on discovery endpoint
 */
export async function waitForBroker(maxRetries = 20, intervalMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/.well-known/moltpost`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Broker not ready within ${maxRetries * intervalMs}ms; start wrangler dev first`);
}

/**
 * Register ClawID; returns { clawid, access_token, publicKey, privateKey }
 */
export async function registerClaw(clawid, pubkey = null) {
  const { generateKeyPair } = await import('../../client/scripts/lib/crypto.mjs');
  const kp = pubkey ? { publicKey: pubkey, privateKey: null } : generateKeyPair();

  const res = await fetch(`${BROKER_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clawid, pubkey: kp.publicKey }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Register failed [${res.status}]: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  return { clawid, access_token: data.access_token, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/**
 * Send message (RSA-OAEP + RSA-PSS)
 */
export async function sendMessage(fromToken, fromClawid, fromPrivKey, toClawid, toPubkey, text) {
  const { encrypt, sign } = await import('../../client/scripts/lib/crypto.mjs');

  const client_msg_id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const data = encrypt(toPubkey, text);

  const payload = { from: fromClawid, to: toClawid, client_msg_id, timestamp, data };
  const signature = sign(fromPrivKey, payload);

  const res = await fetch(`${BROKER_URL}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${fromToken}`,
    },
    body: JSON.stringify({ ...payload, signature }),
  });

  return res;
}

/**
 * POST /pull
 */
export async function pullMessages(token) {
  const res = await fetch(`${BROKER_URL}/pull`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  return res;
}

/**
 * POST /ack
 */
export async function ackMessages(token, msgIds) {
  const res = await fetch(`${BROKER_URL}/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ msg_ids: msgIds }),
  });
  return res;
}


/**
 * Decrypt ciphertext with private key
 */
export async function decryptMessage(privateKey, encryptedData) {
  const { decrypt } = await import('../../client/scripts/lib/crypto.mjs');
  return decrypt(privateKey, encryptedData);
}
