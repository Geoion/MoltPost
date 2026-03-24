/**
 * E2E: ClawGroup
 * Broker at BROKER_URL (default http://localhost:8787)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { BROKER_URL, waitForBroker, registerClaw } from './helpers.mjs';

beforeAll(async () => {
  await waitForBroker();
}, 15000);

async function authedPost(path, token, body) {
  return fetch(`${BROKER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function authedGet(path, token, params = {}) {
  const url = new URL(`${BROKER_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('Group create and join', () => {
  let owner, member1, member2;
  let groupId;
  const suffix = Date.now();

  beforeAll(async () => {
    owner = await registerClaw(`e2e-owner-${suffix}`);
    member1 = await registerClaw(`e2e-m1-${suffix}`);
    member2 = await registerClaw(`e2e-m2-${suffix}`);
  });

  it('creates group', async () => {
    const res = await authedPost('/group/create', owner.access_token, {
      group_id: `group-${suffix}`,
      name: 'E2E Test Group',
      policy: 'broadcast',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.group_id).toBe(`group-${suffix}`);
    groupId = data.group_id;
  });

  it('returns 409 for duplicate group_id', async () => {
    const res = await authedPost('/group/create', owner.access_token, {
      group_id: `group-${suffix}`,
      name: 'Duplicate',
      policy: 'broadcast',
    });
    expect(res.status).toBe(409);
  });

  it('mints invite and member joins', async () => {
    const res = await authedPost('/group/invite', owner.access_token, {
      group_id: `group-${suffix}`,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.invite_token).toBeTruthy();

    const joinRes = await authedPost('/group/join', member1.access_token, {
      group_id: `group-${suffix}`,
      invite_token: data.invite_token,
    });
    expect(joinRes.status).toBe(200);
  });

  it('returns 403 for invalid invite token', async () => {
    const res = await authedPost('/group/join', member2.access_token, {
      group_id: `group-${suffix}`,
      invite_token: 'invalid-token-xyz',
    });
    expect(res.status).toBe(403);
  });

  it('lists group members', async () => {
    const res = await authedGet('/group/peers', owner.access_token, {
      group_id: `group-${suffix}`,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.members)).toBe(true);
    const found = data.members.find((m) => m.clawid === owner.clawid);
    expect(found).toBeTruthy();
  });

  it('member can leave', async () => {
    const res = await authedPost('/group/leave', member1.access_token, {
      group_id: `group-${suffix}`,
    });
    expect(res.status).toBe(200);
  });
});

describe('Group broadcast', () => {
  let owner, memberA, memberB;
  let groupId;
  const suffix = Date.now() + 1;

  beforeAll(async () => {
    owner = await registerClaw(`e2e-bcast-owner-${suffix}`);
    memberA = await registerClaw(`e2e-bcast-a-${suffix}`);
    memberB = await registerClaw(`e2e-bcast-b-${suffix}`);

    await authedPost('/group/create', owner.access_token, {
      group_id: `bcast-group-${suffix}`,
      name: 'Broadcast Group',
      policy: 'broadcast',
    });
    groupId = `bcast-group-${suffix}`;

    const invA = await (await authedPost('/group/invite', owner.access_token, { group_id: groupId })).json();
    await authedPost('/group/join', memberA.access_token, { group_id: groupId, invite_token: invA.invite_token });

    const invB = await (await authedPost('/group/invite', owner.access_token, { group_id: groupId })).json();
    await authedPost('/group/join', memberB.access_token, { group_id: groupId, invite_token: invB.invite_token });
  });

  it('owner broadcast succeeds', async () => {
    const res = await authedPost('/group/send', owner.access_token, {
      group_id: groupId,
      data: 'broadcast-encrypted-payload',
      signature: 'fake-sig-for-e2e',
      client_msg_id: `bcast-${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('returns 403 when outsider sends to group', async () => {
    const outsider = await registerClaw(`e2e-outsider-${suffix}`);
    const res = await authedPost('/group/send', outsider.access_token, {
      group_id: groupId,
      data: 'unauthorized',
      signature: 'fake-sig',
      client_msg_id: `outsider-${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    expect(res.status).toBe(403);
  });
});

describe('Allowlist', () => {
  let userA, userB, userC;
  const suffix = Date.now() + 2;

  beforeAll(async () => {
    userA = await registerClaw(`e2e-al-a-${suffix}`);
    userB = await registerClaw(`e2e-al-b-${suffix}`);
    userC = await registerClaw(`e2e-al-c-${suffix}`);
  });

  it('blocks send when recipient allowlist excludes sender', async () => {
    const clawA = userA.clawid;
    const clawB = userB.clawid;
    const clawC = userC.clawid;

    const setRes = await fetch(`${BROKER_URL}/allowlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userB.access_token}`,
      },
      body: JSON.stringify({ allowed: [clawA] }),
    });
    expect(setRes.status).toBe(200);

    const sendRes = await fetch(`${BROKER_URL}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userC.access_token}`,
      },
      body: JSON.stringify({
        from: clawC,
        to: clawB,
        client_msg_id: `al-test-${Date.now()}`,
        timestamp: Math.floor(Date.now() / 1000),
        data: 'blocked-message',
        signature: 'fake-sig',
      }),
    });
    expect(sendRes.status).toBe(403);
  });

  it('GET allowlist', async () => {
    const res = await fetch(`${BROKER_URL}/allowlist`, {
      headers: { Authorization: `Bearer ${userB.access_token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.allowed)).toBe(true);
  });
});
