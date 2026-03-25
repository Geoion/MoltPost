import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  encrypt,
  decrypt,
  sign,
  verify,
  generateECDHKeyPair,
  deriveSessionKey,
  encryptAESGCM,
  decryptAESGCM,
  pubkeyFingerprint,
} from '../../client/scripts/lib/crypto.mjs';

describe('RSA-2048 key pair generation', () => {
  it('produces PEM public and private keys', () => {
    const { privateKey, publicKey } = generateKeyPair();
    expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('generates a different key pair each time', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
  });
});

describe('RSA-OAEP encrypt/decrypt', () => {
  const { privateKey, publicKey } = generateKeyPair();

  it('decrypts ciphertext back to plaintext', () => {
    const plaintext = 'Hello, MoltPost!';
    const ciphertext = encrypt(publicKey, plaintext);
    const decrypted = decrypt(privateKey, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('ciphertext is a hex string', () => {
    const ciphertext = encrypt(publicKey, 'test');
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it('same plaintext yields different ciphertext (RSA-OAEP random padding)', () => {
    const c1 = encrypt(publicKey, 'same message');
    const c2 = encrypt(publicKey, 'same message');
    expect(c1).not.toBe(c2);
  });

  it('throws when decrypting with the wrong private key', () => {
    const { privateKey: wrongKey } = generateKeyPair();
    const ciphertext = encrypt(publicKey, 'secret');
    expect(() => decrypt(wrongKey, ciphertext)).toThrow();
  });

  it('supports non-ASCII / Unicode plaintext', () => {
    const plaintext = 'Hello, café — テスト 🎉';
    const ciphertext = encrypt(publicKey, plaintext);
    expect(decrypt(privateKey, ciphertext)).toBe(plaintext);
  });

  it('supports long plaintext near RSA-2048 limits', () => {
    const plaintext = 'A'.repeat(180);
    const ciphertext = encrypt(publicKey, plaintext);
    expect(decrypt(privateKey, ciphertext)).toBe(plaintext);
  });
});

describe('RSA-PSS sign/verify', () => {
  const { privateKey, publicKey } = generateKeyPair();

  const payload = {
    from: 'alice',
    to: 'bob',
    client_msg_id: 'msg-001',
    timestamp: 1700000000,
    data: 'encrypted-hex-blob',
  };

  it('verify succeeds after sign', () => {
    const sig = sign(privateKey, payload);
    expect(verify(publicKey, payload, sig)).toBe(true);
  });

  it('signature is a hex string', () => {
    const sig = sign(privateKey, payload);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  it('verify fails if from is tampered', () => {
    const sig = sign(privateKey, payload);
    const tampered = { ...payload, from: 'mallory' };
    expect(verify(publicKey, tampered, sig)).toBe(false);
  });

  it('verify fails if data is tampered', () => {
    const sig = sign(privateKey, payload);
    const tampered = { ...payload, data: 'tampered-data' };
    expect(verify(publicKey, tampered, sig)).toBe(false);
  });

  it('verify fails with wrong public key', () => {
    const { publicKey: wrongPub } = generateKeyPair();
    const sig = sign(privateKey, payload);
    expect(verify(wrongPub, payload, sig)).toBe(false);
  });

  it('invalid signature hex returns false', () => {
    expect(verify(publicKey, payload, 'deadbeef')).toBe(false);
  });
});

describe('ECDH X25519 + AES-GCM forward secrecy', () => {
  it('generates an X25519 key pair', () => {
    const { privateKey, publicKey } = generateECDHKeyPair();
    expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('both parties derive the same session key', () => {
    const alice = generateECDHKeyPair();
    const bob = generateECDHKeyPair();
    const keyA = deriveSessionKey(alice.privateKey, bob.publicKey);
    const keyB = deriveSessionKey(bob.privateKey, alice.publicKey);
    expect(Buffer.from(keyA).toString('hex')).toBe(Buffer.from(keyB).toString('hex'));
  });

  it('AES-GCM decrypts after encrypt', () => {
    const alice = generateECDHKeyPair();
    const bob = generateECDHKeyPair();
    const sessionKey = deriveSessionKey(alice.privateKey, bob.publicKey);

    const plaintext = 'Forward secrecy test message';
    const ciphertext = encryptAESGCM(sessionKey, plaintext);
    const decrypted = decryptAESGCM(sessionKey, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('AES-GCM ciphertext is hex', () => {
    const { privateKey, publicKey } = generateECDHKeyPair();
    const sessionKey = deriveSessionKey(privateKey, publicKey);
    const ciphertext = encryptAESGCM(sessionKey, 'test');
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it('same plaintext yields different ciphertext (random IV)', () => {
    const { privateKey, publicKey } = generateECDHKeyPair();
    const sessionKey = deriveSessionKey(privateKey, publicKey);
    const c1 = encryptAESGCM(sessionKey, 'same');
    const c2 = encryptAESGCM(sessionKey, 'same');
    expect(c1).not.toBe(c2);
  });

  it('throws when decrypting with wrong session key', () => {
    const alice = generateECDHKeyPair();
    const bob = generateECDHKeyPair();
    const carol = generateECDHKeyPair();

    const sessionKey = deriveSessionKey(alice.privateKey, bob.publicKey);
    const wrongKey = deriveSessionKey(alice.privateKey, carol.publicKey);

    const ciphertext = encryptAESGCM(sessionKey, 'secret');
    expect(() => decryptAESGCM(wrongKey, ciphertext)).toThrow();
  });
});

describe('Public key fingerprint', () => {
  it('is stable for the same public key', () => {
    const { publicKey } = generateKeyPair();
    expect(pubkeyFingerprint(publicKey)).toBe(pubkeyFingerprint(publicKey));
  });

  it('differs across different public keys', () => {
    const { publicKey: pub1 } = generateKeyPair();
    const { publicKey: pub2 } = generateKeyPair();
    expect(pubkeyFingerprint(pub1)).not.toBe(pubkeyFingerprint(pub2));
  });

  it('is 64 hex chars (SHA-256)', () => {
    const { publicKey } = generateKeyPair();
    expect(pubkeyFingerprint(publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });
});
