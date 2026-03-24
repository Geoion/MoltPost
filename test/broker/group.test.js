import { describe, it, expect, beforeEach } from 'vitest';
import { handleGroupCreate } from '../../broker/src/routes/group/create.js';
import { handleGroupInvite } from '../../broker/src/routes/group/invite.js';
import { handleGroupJoin } from '../../broker/src/routes/group/join.js';
import { handleGroupLeave } from '../../broker/src/routes/group/leave.js';
import { handleGroupPeers } from '../../broker/src/routes/group/peers.js';
import { handleGroupSend } from '../../broker/src/routes/group/send.js';
import { createMockEnv, makeRequest, registerClaw } from './helpers.js';

describe('ClawGroup', () => {
  let env;
  let ownerToken;
  let memberToken;
  let outsiderToken;

  beforeEach(async () => {
    env = createMockEnv();
    ownerToken = await registerClaw(env, 'owner-claw');
    memberToken = await registerClaw(env, 'member-claw');
    outsiderToken = await registerClaw(env, 'outsider-claw');
  });

  async function createGroup(groupId = 'test-group', policy = {}) {
    const req = makeRequest(
      'POST',
      '/group/create',
      { group_id: groupId, owner_clawid: 'owner-claw', policy },
      { Authorization: `Bearer ${ownerToken}` }
    );
    return handleGroupCreate(req, env);
  }

  async function getInviteToken(groupId) {
    const req = makeRequest(
      'POST',
      '/group/invite',
      { group_id: groupId },
      { Authorization: `Bearer ${ownerToken}` }
    );
    const res = await handleGroupInvite(req, env);
    const data = await res.json();
    return data.invite_token;
  }

  async function joinGroup(token, clawid, groupId, inviteToken) {
    const req = makeRequest(
      'POST',
      '/group/join',
      { group_id: groupId, clawid, invite_token: inviteToken },
      { Authorization: `Bearer ${token}` }
    );
    return handleGroupJoin(req, env);
  }

  describe('POST /group/create', () => {
    it('creates group', async () => {
      const res = await createGroup();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.group.group_id).toBe('test-group');
      expect(data.group.owner_clawid).toBe('owner-claw');
    });

    it('returns 409 when group_id exists', async () => {
      await createGroup('dup-group');
      const res = await createGroup('dup-group');
      expect(res.status).toBe(409);
    });

    it('returns 403 when owner_clawid mismatches token', async () => {
      const req = makeRequest(
        'POST',
        '/group/create',
        { group_id: 'bad-group', owner_clawid: 'member-claw' },
        { Authorization: `Bearer ${ownerToken}` }
      );
      const res = await handleGroupCreate(req, env);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /group/invite + POST /group/join', () => {
    it('invite token then join', async () => {
      await createGroup('invite-group');
      const inviteToken = await getInviteToken('invite-group');
      expect(inviteToken).toBeTruthy();

      const joinRes = await joinGroup(memberToken, 'member-claw', 'invite-group', inviteToken);
      expect(joinRes.status).toBe(200);
    });

    it('returns 403 for invalid invite token', async () => {
      await createGroup('invite-group2');
      const joinRes = await joinGroup(memberToken, 'member-claw', 'invite-group2', 'invalid-token');
      expect(joinRes.status).toBe(403);
    });
  });

  describe('GET /group/peers', () => {
    it('member can list peers', async () => {
      await createGroup('peers-group');
      const inviteToken = await getInviteToken('peers-group');
      await joinGroup(memberToken, 'member-claw', 'peers-group', inviteToken);

      const req = new Request('https://moltpost.example.com/group/peers?group_id=peers-group', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': `test-req-${Date.now()}`,
          Authorization: `Bearer ${memberToken}`,
        },
      });
      const res = await handleGroupPeers(req, env);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.members.some((m) => m.clawid === 'owner-claw')).toBe(true);
    });

    it('returns 403 for non-member', async () => {
      await createGroup('private-group');
      const req = new Request('https://moltpost.example.com/group/peers?group_id=private-group', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': `test-req-${Date.now()}`,
          Authorization: `Bearer ${outsiderToken}`,
        },
      });
      const res = await handleGroupPeers(req, env);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /group/send', () => {
    it('broadcast delivers to all members', async () => {
      await createGroup('broadcast-group', { send_policy: 'broadcast' });
      const inviteToken = await getInviteToken('broadcast-group');
      await joinGroup(memberToken, 'member-claw', 'broadcast-group', inviteToken);

      const req = makeRequest(
        'POST',
        '/group/send',
        {
          group_id: 'broadcast-group',
          from: 'owner-claw',
          mode: 'broadcast',
          data: 'hello group',
          signature: 'fake-sig',
          client_msg_id: `bcast-${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
        },
        { Authorization: `Bearer ${ownerToken}` }
      );
      const res = await handleGroupSend(req, env);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it('owner_only: non-owner broadcast returns 403', async () => {
      await createGroup('owner-only-group', { send_policy: 'owner_only' });
      const inviteToken = await getInviteToken('owner-only-group');
      await joinGroup(memberToken, 'member-claw', 'owner-only-group', inviteToken);

      const req = makeRequest(
        'POST',
        '/group/send',
        {
          group_id: 'owner-only-group',
          from: 'member-claw',
          mode: 'broadcast',
          data: 'hello',
          signature: 'fake-sig',
          client_msg_id: `oo-${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
        },
        { Authorization: `Bearer ${memberToken}` }
      );
      const res = await handleGroupSend(req, env);
      expect(res.status).toBe(403);
    });

    it('unicast to selected member', async () => {
      await createGroup('unicast-group', { send_policy: 'broadcast' });
      const inviteToken = await getInviteToken('unicast-group');
      await joinGroup(memberToken, 'member-claw', 'unicast-group', inviteToken);

      const req = makeRequest(
        'POST',
        '/group/send',
        {
          group_id: 'unicast-group',
          from: 'owner-claw',
          mode: 'unicast',
          to: ['member-claw'],
          data: 'private',
          signature: 'fake-sig',
          client_msg_id: `uni-${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
        },
        { Authorization: `Bearer ${ownerToken}` }
      );
      const res = await handleGroupSend(req, env);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /group/leave', () => {
    it('member can leave', async () => {
      await createGroup('leave-group');
      const inviteToken = await getInviteToken('leave-group');
      await joinGroup(memberToken, 'member-claw', 'leave-group', inviteToken);

      const req = makeRequest(
        'POST',
        '/group/leave',
        { group_id: 'leave-group', clawid: 'member-claw' },
        { Authorization: `Bearer ${memberToken}` }
      );
      const res = await handleGroupLeave(req, env);
      expect(res.status).toBe(200);
    });

    it('owner leave dissolves group', async () => {
      await createGroup('dissolve-group');
      const inviteToken = await getInviteToken('dissolve-group');
      await joinGroup(memberToken, 'member-claw', 'dissolve-group', inviteToken);

      const req = makeRequest(
        'POST',
        '/group/leave',
        { group_id: 'dissolve-group', clawid: 'owner-claw' },
        { Authorization: `Bearer ${ownerToken}` }
      );
      const res = await handleGroupLeave(req, env);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.action).toBe('group_dissolved');
    });
  });
});
