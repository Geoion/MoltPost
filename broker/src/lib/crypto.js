/**
 * Broker-side signature verification (Web Crypto on Workers)
 */

/**
 * Import SPKI PEM as CryptoKey
 * @param {string} pem
 */
async function importPublicKey(pem) {
  const pemBody = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');

  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'spki',
    der,
    {
      name: 'RSA-PSS',
      hash: 'SHA-256',
    },
    false,
    ['verify']
  );
}

/**
 * Canonical signing string (matches client): from|to|client_msg_id|timestamp|sha256(data)
 */
async function buildSignatureMessage(payload) {
  const dataBytes = new TextEncoder().encode(payload.data || '');
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
  const dataHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return [
    payload.from,
    payload.to,
    payload.client_msg_id,
    String(payload.timestamp),
    dataHash,
  ].join('|');
}

/**
 * Verify payload signature
 * @param {string} pubkeyPem
 * @param {object} payload
 * @param {string} signatureHex
 * @returns {boolean}
 */
export async function verifySignature(pubkeyPem, payload, signatureHex) {
  try {
    const publicKey = await importPublicKey(pubkeyPem);
    const message = await buildSignatureMessage(payload);
    const messageBytes = new TextEncoder().encode(message);

    const signatureBytes = Uint8Array.from(
      signatureHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    );

    return await crypto.subtle.verify(
      {
        name: 'RSA-PSS',
        saltLength: 32,
      },
      publicKey,
      signatureBytes,
      messageBytes
    );
  } catch {
    return false;
  }
}

/**
 * Verify an arbitrary string signed with RSA-PSS SHA-256
 * Used by /recover to verify challenge strings
 * @param {string} pubkeyPem
 * @param {string} message  - the raw string that was signed
 * @param {string} signatureHex
 * @returns {boolean}
 */
export async function verifyStringSignature(pubkeyPem, message, signatureHex) {
  try {
    const publicKey = await importPublicKey(pubkeyPem);
    const messageBytes = new TextEncoder().encode(message);

    const signatureBytes = Uint8Array.from(
      signatureHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    );

    return await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 32 },
      publicKey,
      signatureBytes,
      messageBytes
    );
  } catch {
    return false;
  }
}
