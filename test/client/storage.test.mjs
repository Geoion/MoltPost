import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// MOLTPOST_HOME is read at module top level in storage.mjs — set env before import
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moltpost-storage-test-'));
process.env.MOLTPOST_HOME = tmpDir;

const {
  readConfig,
  writeConfig,
  readActiveInbox,
  appendMessages,
  archiveMessages,
  updateMessage,
  readPeers,
  updatePeersCache,
  getPeerPubkey,
  appendAudit,
} = await import('../../client/scripts/lib/storage.mjs');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function cleanTmpDir() {
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
  }
}

describe('config.json read/write', () => {
  beforeAll(cleanTmpDir);

  it('readConfig returns null when file is missing', () => {
    expect(readConfig()).toBeNull();
  });

  it('writeConfig and readConfig round-trip', () => {
    const config = {
      broker_url: 'https://test.workers.dev',
      clawid: 'test-claw',
      access_token: 'token-abc',
    };
    writeConfig(config);
    expect(readConfig()).toEqual(config);
  });

  it('writeConfig creates directories and writes the file', () => {
    cleanTmpDir();
    writeConfig({ clawid: 'test' });
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);
  });
});

describe('inbox/active.json rolling queue', () => {
  beforeAll(cleanTmpDir);

  it('readActiveInbox returns empty structure when file is missing', () => {
    const inbox = readActiveInbox();
    expect(inbox.version).toBe(1);
    expect(inbox.messages).toEqual([]);
  });

  it('appendMessages appends messages', () => {
    cleanTmpDir();
    const now = Math.floor(Date.now() / 1000);
    const msgs = [
      { id: 'msg-1', from: 'alice', content: 'hello', timestamp: now },
      { id: 'msg-2', from: 'bob', content: 'world', timestamp: now + 1 },
    ];
    appendMessages(msgs, {});
    const inbox = readActiveInbox();
    expect(inbox.messages).toHaveLength(2);
    expect(inbox.messages[0].id).toBe('msg-1');
  });

  it('archives oldest messages when over active_max', () => {
    cleanTmpDir();
    const config = { inbox: { active_max: 5, archive_after_days: 365 } };
    const now = Math.floor(Date.now() / 1000);

    const batch1 = Array.from({ length: 5 }, (_, i) => ({
      id: `msg-${i}`,
      from: 'alice',
      content: `msg ${i}`,
      timestamp: now + i,
    }));
    appendMessages(batch1, config);

    const batch2 = Array.from({ length: 3 }, (_, i) => ({
      id: `msg-new-${i}`,
      from: 'alice',
      content: `new ${i}`,
      timestamp: now + 1000 + i,
    }));
    appendMessages(batch2, config);

    const inbox = readActiveInbox();
    expect(inbox.messages.length).toBeLessThanOrEqual(5);
  });

  it('archives messages older than archive_after_days', () => {
    cleanTmpDir();
    const now = Math.floor(Date.now() / 1000);
    const config = { inbox: { active_max: 200, archive_after_days: 7 } };

    const msgs = [
      { id: 'old-msg', from: 'alice', content: 'old', timestamp: now - 8 * 86400 },
      { id: 'new-msg', from: 'alice', content: 'new', timestamp: now },
    ];
    appendMessages(msgs, config);

    const inbox = readActiveInbox();
    const ids = inbox.messages.map((m) => m.id);
    expect(ids).not.toContain('old-msg');
    expect(ids).toContain('new-msg');
  });

  it('updateMessage updates message fields', () => {
    cleanTmpDir();
    const now = Math.floor(Date.now() / 1000);
    appendMessages([{ id: 'msg-x', from: 'alice', content: 'hi', timestamp: now }], {});
    updateMessage('msg-x', { isRead: true });
    const inbox = readActiveInbox();
    expect(inbox.messages[0].isRead).toBe(true);
  });

  it('updateMessage returns false for unknown id', () => {
    expect(updateMessage('nonexistent', { isRead: true })).toBe(false);
  });
});

describe('archiveMessages', () => {
  beforeAll(cleanTmpDir);

  it('writes messages to the correct monthly JSONL file', () => {
    cleanTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'inbox'), { recursive: true });
    const msgs = [{ id: 'msg-1', from: 'alice', content: 'hi', timestamp: 1700000000 }];
    archiveMessages(msgs);

    const archivePath = path.join(tmpDir, 'inbox', '2023-11.jsonl');
    expect(fs.existsSync(archivePath)).toBe(true);
    const lines = fs.readFileSync(archivePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe('msg-1');
  });

  it('appends same-month messages to the same file', () => {
    cleanTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'inbox'), { recursive: true });
    archiveMessages([{ id: 'msg-1', timestamp: 1700000000 }]);
    archiveMessages([{ id: 'msg-2', timestamp: 1700001000 }]);

    const archivePath = path.join(tmpDir, 'inbox', '2023-11.jsonl');
    const lines = fs.readFileSync(archivePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('writes different months to different files', () => {
    cleanTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'inbox'), { recursive: true });
    archiveMessages([
      { id: 'nov', timestamp: 1700000000 },
      { id: 'dec', timestamp: 1701388800 },
    ]);

    expect(fs.existsSync(path.join(tmpDir, 'inbox', '2023-11.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'inbox', '2023-12.jsonl'))).toBe(true);
  });
});

describe('peers.json cache', () => {
  beforeAll(cleanTmpDir);

  it('readPeers returns {} when file is missing', () => {
    expect(readPeers()).toEqual({});
  });

  it('updatePeersCache persists and readPeers reads it', () => {
    updatePeersCache([
      { clawid: 'alice', pubkey: 'pubkey-alice', pubkey_version: 1, last_seen: 1700000000 },
    ]);
    const peers = readPeers();
    expect(peers['alice'].pubkey).toBe('pubkey-alice');
    expect(peers['alice'].cached_at).toBeGreaterThan(0);
  });

  it('getPeerPubkey returns pubkey when not expired', () => {
    updatePeersCache([{ clawid: 'bob', pubkey: 'pk-bob', pubkey_version: 1, last_seen: 1700000000 }]);
    expect(getPeerPubkey('bob', {})).toBe('pk-bob');
  });

  it('getPeerPubkey returns null for unknown ClawID', () => {
    expect(getPeerPubkey('nonexistent', {})).toBeNull();
  });
});

describe('audit.jsonl append', () => {
  beforeAll(cleanTmpDir);

  it('appendAudit writes JSONL lines', () => {
    appendAudit({ op: 'pull', count: 3 });
    appendAudit({ op: 'send', to: 'bob' });

    const auditPath = path.join(tmpDir, 'audit.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.op).toBe('pull');
    expect(entry1.ts).toBeGreaterThan(0);

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.op).toBe('send');
    expect(entry2.to).toBe('bob');
  });
});
