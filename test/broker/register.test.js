import { describe, it, expect, beforeEach } from 'vitest';
import { handleRegister } from '../../broker/src/routes/register.js';
import { createMockEnv, makeRequest } from './helpers.js';

describe('POST /register', () => {
  let env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it('returns access_token on success', async () => {
    const req = makeRequest('POST', '/register', {
      clawid: 'test-claw',
      pubkey: 'rsa-pubkey-base64',
    });
    const res = await handleRegister(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeTruthy();
    expect(typeof data.access_token).toBe('string');
  });

  it('returns 409 when ClawID already registered', async () => {
    const req1 = makeRequest('POST', '/register', { clawid: 'dup-claw', pubkey: 'pk1' });
    await handleRegister(req1, env);

    const req2 = makeRequest('POST', '/register', { clawid: 'dup-claw', pubkey: 'pk2' });
    const res = await handleRegister(req2, env);
    expect(res.status).toBe(409);
  });

  it('force re-register with old token succeeds', async () => {
    const req1 = makeRequest('POST', '/register', { clawid: 'force-claw', pubkey: 'pk1' });
    const res1 = await handleRegister(req1, env);
    const { access_token } = await res1.json();

    const req2 = makeRequest(
      'POST',
      '/register',
      { clawid: 'force-claw', pubkey: 'pk2' },
      { Authorization: `Bearer ${access_token}`, 'X-Force-Register': 'true' }
    );
    const res2 = await handleRegister(req2, env);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.access_token).toBeTruthy();
    expect(data2.access_token).not.toBe(access_token);
  });

  it('returns 401 for force without old token', async () => {
    const req1 = makeRequest('POST', '/register', { clawid: 'force-claw2', pubkey: 'pk1' });
    await handleRegister(req1, env);

    const req2 = makeRequest(
      'POST',
      '/register',
      { clawid: 'force-claw2', pubkey: 'pk2' },
      { 'X-Force-Register': 'true' }
    );
    const res2 = await handleRegister(req2, env);
    expect(res2.status).toBe(401);
  });

  it('returns 400 for missing pubkey', async () => {
    const req = makeRequest('POST', '/register', { clawid: 'no-pubkey' });
    const res = await handleRegister(req, env);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid clawid format', async () => {
    const req = makeRequest('POST', '/register', { clawid: 'invalid claw!', pubkey: 'pk' });
    const res = await handleRegister(req, env);
    expect(res.status).toBe(400);
  });

  it('creates ClawGroup when group_name is set', async () => {
    const req = makeRequest('POST', '/register', {
      clawid: 'owner-claw',
      pubkey: 'pk',
      group_name: 'my-group',
    });
    const res = await handleRegister(req, env);
    expect(res.status).toBe(200);
    const groupRaw = await env.GROUPS.get('group:my-group');
    expect(groupRaw).toBeTruthy();
    const group = JSON.parse(groupRaw);
    expect(group.owner_clawid).toBe('owner-claw');
  });
});
