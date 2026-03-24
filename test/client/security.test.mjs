import { describe, it, expect } from 'vitest';
import { scan, scanSafe } from '../../client/scripts/lib/security.mjs';

describe('安全扫描 scan()', () => {
  it('正常内容不抛出异常', () => {
    expect(() => scan('Hello, this is a normal message')).not.toThrow();
    expect(() => scan('任务已完成，结果如下：成功')).not.toThrow();
  });

  it('包含 OPENAI_API_KEY 抛出异常', () => {
    expect(() => scan('my OPENAI_API_KEY is abc123')).toThrow('Security scan failed');
  });

  it('包含 sk- 抛出异常', () => {
    expect(() => scan('token: sk-proj-xxxxxxxxxxxx')).toThrow('Security scan failed');
  });

  it('包含 Bearer 抛出异常', () => {
    expect(() => scan('Authorization: Bearer eyJhbGci...')).toThrow('Security scan failed');
  });

  it('包含 password 抛出异常', () => {
    expect(() => scan('my password is 12345')).toThrow('Security scan failed');
  });

  it('大小写不敏感', () => {
    expect(() => scan('OPENAI_api_key=xxx')).toThrow('Security scan failed');
    expect(() => scan('SK-proj-xxx')).toThrow('Security scan failed');
  });

  it('空字符串不抛出异常', () => {
    expect(() => scan('')).not.toThrow();
    expect(() => scan(null)).not.toThrow();
    expect(() => scan(undefined)).not.toThrow();
  });

  it('自定义 patterns 生效', () => {
    expect(() => scan('my_secret_token=abc', ['my_secret_token'])).toThrow('Security scan failed');
    expect(() => scan('normal text', ['my_secret_token'])).not.toThrow();
  });

  it('空 patterns 列表不扫描', () => {
    expect(() => scan('sk-proj-xxx', [])).not.toThrow();
  });
});

describe('安全扫描 scanSafe()', () => {
  it('安全内容返回 { safe: true }', () => {
    const result = scanSafe('Hello world');
    expect(result.safe).toBe(true);
  });

  it('危险内容返回 { safe: false, matched }', () => {
    const result = scanSafe('my OPENAI_API_KEY=xxx');
    expect(result.safe).toBe(false);
    expect(result.matched).toContain('Security scan failed');
  });

  it('不抛出异常', () => {
    expect(() => scanSafe('sk-proj-xxx')).not.toThrow();
  });
});
