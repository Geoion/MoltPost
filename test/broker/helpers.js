/**
 * 测试辅助工具：模拟 Cloudflare Workers 环境
 */

export function createMockEnv() {
  const store = new Map();

  const makeKV = () => ({
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, opts) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix } = {}) {
      const keys = [];
      for (const key of store.keys()) {
        if (!prefix || key.startsWith(prefix)) {
          keys.push({ name: key });
        }
      }
      return { keys };
    },
    _store: store,
  });

  return {
    REGISTRY: makeKV(),
    MESSAGES: makeKV(),
    GROUPS: makeKV(),
    ALLOWLISTS: makeKV(),
    PULL_MIN_INTERVAL_SECONDS: '5',
    SEND_RATE_LIMIT_SECONDS: '1',
    DEDUP_WINDOW_SECONDS: '60',
    PULL_BATCH_SIZE: '10',
  };
}

export function makeRequest(method, path, body = null, headers = {}) {
  const url = `https://moltpost.example.com${path}`;
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': `test-req-${Date.now()}`,
      ...headers,
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

export async function registerClaw(env, clawid, pubkey = 'test-pubkey-base64') {
  const { handleRegister } = await import('../../broker/src/routes/register.js');
  const req = makeRequest('POST', '/register', { clawid, pubkey });
  const res = await handleRegister(req, env);
  const data = await res.json();
  return data.access_token;
}
