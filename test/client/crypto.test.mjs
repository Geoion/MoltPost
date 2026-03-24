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

describe('RSA-2048 密钥对生成', () => {
  it('生成的密钥对包含 PEM 格式的公钥和私钥', () => {
    const { privateKey, publicKey } = generateKeyPair();
    expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('每次生成的密钥对不同', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
  });
});

describe('RSA-OAEP 加解密', () => {
  const { privateKey, publicKey } = generateKeyPair();

  it('加密后可以解密还原明文', () => {
    const plaintext = 'Hello, MoltPost!';
    const ciphertext = encrypt(publicKey, plaintext);
    const decrypted = decrypt(privateKey, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('加密结果为 hex 字符串', () => {
    const ciphertext = encrypt(publicKey, 'test');
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it('相同明文每次加密结果不同（RSA-OAEP 随机填充）', () => {
    const c1 = encrypt(publicKey, 'same message');
    const c2 = encrypt(publicKey, 'same message');
    expect(c1).not.toBe(c2);
  });

  it('用错误私钥解密抛出异常', () => {
    const { privateKey: wrongKey } = generateKeyPair();
    const ciphertext = encrypt(publicKey, 'secret');
    expect(() => decrypt(wrongKey, ciphertext)).toThrow();
  });

  it('支持加密中文内容', () => {
    const plaintext = '你好，这是一条测试消息！';
    const ciphertext = encrypt(publicKey, plaintext);
    expect(decrypt(privateKey, ciphertext)).toBe(plaintext);
  });

  it('支持加密较长内容（接近 RSA-2048 限制）', () => {
    const plaintext = 'A'.repeat(180);
    const ciphertext = encrypt(publicKey, plaintext);
    expect(decrypt(privateKey, ciphertext)).toBe(plaintext);
  });
});

describe('RSA-PSS 签名验签', () => {
  const { privateKey, publicKey } = generateKeyPair();

  const payload = {
    from: 'alice',
    to: 'bob',
    client_msg_id: 'msg-001',
    timestamp: 1700000000,
    data: 'encrypted-hex-blob',
  };

  it('签名后可以验签通过', () => {
    const sig = sign(privateKey, payload);
    expect(verify(publicKey, payload, sig)).toBe(true);
  });

  it('签名结果为 hex 字符串', () => {
    const sig = sign(privateKey, payload);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  it('篡改 from 字段后验签失败', () => {
    const sig = sign(privateKey, payload);
    const tampered = { ...payload, from: 'mallory' };
    expect(verify(publicKey, tampered, sig)).toBe(false);
  });

  it('篡改 data 字段后验签失败', () => {
    const sig = sign(privateKey, payload);
    const tampered = { ...payload, data: 'tampered-data' };
    expect(verify(publicKey, tampered, sig)).toBe(false);
  });

  it('用错误公钥验签失败', () => {
    const { publicKey: wrongPub } = generateKeyPair();
    const sig = sign(privateKey, payload);
    expect(verify(wrongPub, payload, sig)).toBe(false);
  });

  it('无效签名字符串返回 false', () => {
    expect(verify(publicKey, payload, 'deadbeef')).toBe(false);
  });
});

describe('ECDH X25519 + AES-GCM 前向保密', () => {
  it('生成 X25519 密钥对', () => {
    const { privateKey, publicKey } = generateECDHKeyPair();
    expect(privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(publicKey).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('双方协商出相同的会话密钥', () => {
    const alice = generateECDHKeyPair();
    const bob = generateECDHKeyPair();
    const keyA = deriveSessionKey(alice.privateKey, bob.publicKey);
    const keyB = deriveSessionKey(bob.privateKey, alice.publicKey);
    expect(Buffer.from(keyA).toString('hex')).toBe(Buffer.from(keyB).toString('hex'));
  });

  it('AES-GCM 加密后可以解密', () => {
    const alice = generateECDHKeyPair();
    const bob = generateECDHKeyPair();
    const sessionKey = deriveSessionKey(alice.privateKey, bob.publicKey);

    const plaintext = '前向保密测试消息';
    const ciphertext = encryptAESGCM(sessionKey, plaintext);
    const decrypted = decryptAESGCM(sessionKey, ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('AES-GCM 密文格式为 hex', () => {
    const { privateKey, publicKey } = generateECDHKeyPair();
    const sessionKey = deriveSessionKey(privateKey, publicKey);
    const ciphertext = encryptAESGCM(sessionKey, 'test');
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it('相同明文每次加密结果不同（随机 IV）', () => {
    const { privateKey, publicKey } = generateECDHKeyPair();
    const sessionKey = deriveSessionKey(privateKey, publicKey);
    const c1 = encryptAESGCM(sessionKey, 'same');
    const c2 = encryptAESGCM(sessionKey, 'same');
    expect(c1).not.toBe(c2);
  });

  it('错误会话密钥解密抛出异常', () => {
    const alice = generateECDHKeyPair();
    const bob = generateECDHKeyPair();
    const carol = generateECDHKeyPair();

    const sessionKey = deriveSessionKey(alice.privateKey, bob.publicKey);
    const wrongKey = deriveSessionKey(alice.privateKey, carol.publicKey);

    const ciphertext = encryptAESGCM(sessionKey, 'secret');
    expect(() => decryptAESGCM(wrongKey, ciphertext)).toThrow();
  });
});

describe('公钥指纹', () => {
  it('同一公钥指纹一致', () => {
    const { publicKey } = generateKeyPair();
    expect(pubkeyFingerprint(publicKey)).toBe(pubkeyFingerprint(publicKey));
  });

  it('不同公钥指纹不同', () => {
    const { publicKey: pub1 } = generateKeyPair();
    const { publicKey: pub2 } = generateKeyPair();
    expect(pubkeyFingerprint(pub1)).not.toBe(pubkeyFingerprint(pub2));
  });

  it('指纹为 64 位 hex（SHA-256）', () => {
    const { publicKey } = generateKeyPair();
    expect(pubkeyFingerprint(publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });
});
