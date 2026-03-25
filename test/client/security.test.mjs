import { describe, it, expect } from 'vitest';
import { scan, scanSafe } from '../../client/scripts/lib/security.mjs';

describe('security scan()', () => {
  it('does not throw on benign content', () => {
    expect(() => scan('Hello, this is a normal message')).not.toThrow();
    expect(() => scan('Task completed; result: success')).not.toThrow();
  });

  it('throws when content contains OPENAI_API_KEY', () => {
    expect(() => scan('my OPENAI_API_KEY is abc123')).toThrow('Security scan failed');
  });

  it('throws when content contains sk-', () => {
    expect(() => scan('token: sk-proj-xxxxxxxxxxxx')).toThrow('Security scan failed');
  });

  it('throws when content contains Bearer', () => {
    expect(() => scan('Authorization: Bearer eyJhbGci...')).toThrow('Security scan failed');
  });

  it('throws when content contains password', () => {
    expect(() => scan('my password is 12345')).toThrow('Security scan failed');
  });

  it('is case-insensitive for patterns', () => {
    expect(() => scan('OPENAI_api_key=xxx')).toThrow('Security scan failed');
    expect(() => scan('SK-proj-xxx')).toThrow('Security scan failed');
  });

  it('does not throw on empty input', () => {
    expect(() => scan('')).not.toThrow();
    expect(() => scan(null)).not.toThrow();
    expect(() => scan(undefined)).not.toThrow();
  });

  it('applies custom patterns', () => {
    expect(() => scan('my_secret_token=abc', ['my_secret_token'])).toThrow('Security scan failed');
    expect(() => scan('normal text', ['my_secret_token'])).not.toThrow();
  });

  it('does not scan when patterns list is empty', () => {
    expect(() => scan('sk-proj-xxx', [])).not.toThrow();
  });
});

describe('security scanSafe()', () => {
  it('returns { safe: true } for safe content', () => {
    const result = scanSafe('Hello world');
    expect(result.safe).toBe(true);
  });

  it('returns { safe: false, matched } for unsafe content', () => {
    const result = scanSafe('my OPENAI_API_KEY=xxx');
    expect(result.safe).toBe(false);
    expect(result.matched).toContain('Security scan failed');
  });

  it('never throws', () => {
    expect(() => scanSafe('sk-proj-xxx')).not.toThrow();
  });
});
