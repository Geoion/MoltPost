#!/usr/bin/env node
/**
 * MoltPost Broker Admin Tool
 * 通过 wrangler kv 直接查询 Broker 的 KV 数据
 *
 * 用法：
 *   node scripts/admin.mjs users          # 注册用户列表
 *   node scripts/admin.mjs user <clawid>  # 某用户详情
 *   node scripts/admin.mjs messages       # 所有待投递消息
 *   node scripts/admin.mjs pending        # 各用户待拉取消息数
 *   node scripts/admin.mjs groups         # 群组列表
 *   node scripts/admin.mjs group <id>     # 某群组详情
 *   node scripts/admin.mjs allowlists     # 所有 allowlist
 *   node scripts/admin.mjs stats          # 总览统计
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_DIR = path.resolve(__dirname, '..');

// KV namespace IDs from wrangler.toml
const KV = {
  REGISTRY:  '9cd64e9891f84c23959b8c1d6c700ce2',
  GROUPS:    'd58576e276334e349aeb85d3e887af44',
  ALLOWLISTS:'7560c4f7bdcd43d0a4986bf331da238e',
  MESSAGES:  'a137cdaaf5f142fcbc9148794f631dba',
};

const ACCOUNT_ID = 'b9e5dfb41a164d00dc9bd4cffc728742';

// Read OAuth token from wrangler config
function getWranglerToken() {
  // Prefer CLOUDFLARE_API_TOKEN env var
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  const configPath = path.join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml');
  try {
    const content = readFileSync(configPath, 'utf8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch { /* ignore */ }

  // Fallback: try Linux path
  const linuxPath = path.join(homedir(), '.config', 'wrangler', 'config', 'default.toml');
  try {
    const content = readFileSync(linuxPath, 'utf8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch { /* ignore */ }

  throw new Error('No Cloudflare API token found. Run `wrangler login` or set CLOUDFLARE_API_TOKEN.');
}

const CF_TOKEN = getWranglerToken();
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces`;

async function kvList(namespaceId, prefix = '') {
  const url = new URL(`${CF_BASE}/${namespaceId}/keys`);
  if (prefix) url.searchParams.set('prefix', prefix);
  url.searchParams.set('limit', '1000');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV list failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.result || []).map(k => k.name);
}

async function kvGet(namespaceId, key) {
  const url = `${CF_BASE}/${namespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function kvDelete(namespaceId, key) {
  const url = `${CF_BASE}/${namespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`KV delete failed: ${res.status} ${await res.text()}`);
}

// Bulk delete up to 10000 keys at once (CF API limit per request)
async function kvBulkDelete(namespaceId, keys) {
  if (keys.length === 0) return;
  const CHUNK = 10000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const url = `${CF_BASE}/${namespaceId}/bulk/delete`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`KV bulk delete failed: ${res.status} ${await res.text()}`);
  }
}

function fmt(ts) {
  if (!ts) return 'N/A';
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}

function ago(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdUsers() {
  console.log('\n📋 Registered Users\n');
  const keys = await kvList(KV.REGISTRY, 'registry:');
  if (keys.length === 0) { console.log('  (none)'); return; }

  const rows = [];
  for (const key of keys) {
    const clawid = key.replace('registry:', '');
    const rec = await kvGet(KV.REGISTRY, key);
    rows.push({
      clawid,
      pubkey_version: rec?.pubkey_version || 1,
      last_seen: rec?.last_seen,
      created_at: rec?.created_at,
      group: rec?.group_name || '—',
    });
  }

  rows.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  console.log(`  ${'ClawID'.padEnd(20)} ${'Ver'.padEnd(5)} ${'Registered'.padEnd(14)} ${'Last Seen'.padEnd(14)} Group`);
  console.log('  ' + '─'.repeat(72));
  for (const r of rows) {
    // Ver > 1 means the user has re-registered (--force), token was rotated
    const verFlag = r.pubkey_version > 1 ? `v${r.pubkey_version}⟳` : `v${r.pubkey_version} `;
    console.log(
      `  ${r.clawid.padEnd(20)} ${verFlag.padEnd(5)} ${ago(r.created_at).padEnd(14)} ${ago(r.last_seen).padEnd(14)} ${r.group}`
    );
  }
  console.log(`\n  Total: ${rows.length} user(s)`);
  console.log(`  ⟳ = token rotated (re-registered with --force)\n`);
}

async function cmdUser(clawid) {
  if (!clawid) { console.error('Usage: admin.mjs user <clawid>'); process.exit(1); }
  console.log(`\n👤 User: ${clawid}\n`);

  const rec = await kvGet(KV.REGISTRY, `registry:${clawid}`);
  if (!rec || typeof rec !== 'object') { console.log('  Not found.'); return; }

  console.log(`  ClawID:         ${rec.clawid}`);
  console.log(`  Pubkey version: ${rec.pubkey_version}`);
  console.log(`  Created:        ${fmt(rec.created_at)}`);
  console.log(`  Last seen:      ${fmt(rec.last_seen)} (${ago(rec.last_seen)})`);
  console.log(`  Group:          ${rec.group_name || '—'}`);
  console.log(`  Pubkey:         ${rec.pubkey?.slice(0, 60)}...`);

  // Pending messages
  const pending = await kvGet(KV.MESSAGES, `pending:${clawid}`);
  const pendingIds = Array.isArray(pending) ? pending : [];
  console.log(`\n  Pending messages: ${pendingIds.length}`);
  if (pendingIds.length > 0) {
    for (const id of pendingIds.slice(0, 5)) {
      const msg = await kvGet(KV.MESSAGES, `msg:${id}`);
      if (msg && typeof msg === 'object') {
        console.log(`    [${id}] from=${msg.from} ts=${fmt(msg.timestamp)} expires=${fmt(msg.expires_at)}`);
      }
    }
    if (pendingIds.length > 5) console.log(`    ... and ${pendingIds.length - 5} more`);
  }

  // Allowlist
  const allowlist = await kvGet(KV.ALLOWLISTS, `allowlist:${clawid}`);
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    console.log(`\n  Allowlist: ${allowlist.join(', ')}`);
  } else {
    console.log(`\n  Allowlist: (open — accepts all senders)`);
  }
  console.log('');
}

async function cmdMessages() {
  console.log('\n📨 Pending Messages (all users)\n');
  const keys = await kvList(KV.MESSAGES, 'pending:');
  if (keys.length === 0) { console.log('  (no pending messages)\n'); return; }

  let total = 0;
  for (const key of keys) {
    const clawid = key.replace('pending:', '');
    const ids = await kvGet(KV.MESSAGES, key);
    if (!Array.isArray(ids) || ids.length === 0) continue;
    total += ids.length;
    console.log(`  ${clawid}: ${ids.length} pending`);
    for (const id of ids.slice(0, 3)) {
      const msg = await kvGet(KV.MESSAGES, `msg:${id}`);
      if (msg && typeof msg === 'object') {
        const expires = msg.expires_at ? ` expires=${fmt(msg.expires_at)}` : '';
        console.log(`    ↳ [${id}] from=${msg.from} ts=${fmt(msg.timestamp)}${expires}`);
      }
    }
    if (ids.length > 3) console.log(`    ↳ ... and ${ids.length - 3} more`);
  }
  console.log(`\n  Total pending: ${total} message(s)\n`);
}

async function cmdPending() {
  console.log('\n📊 Pending Message Counts\n');
  const keys = await kvList(KV.MESSAGES, 'pending:');
  if (keys.length === 0) { console.log('  (all queues empty)\n'); return; }

  const rows = [];
  for (const key of keys) {
    const clawid = key.replace('pending:', '');
    const ids = await kvGet(KV.MESSAGES, key);
    rows.push({ clawid, count: Array.isArray(ids) ? ids.length : 0 });
  }
  rows.sort((a, b) => b.count - a.count);

  for (const r of rows) {
    const bar = '█'.repeat(Math.min(r.count, 20));
    console.log(`  ${r.clawid.padEnd(20)} ${String(r.count).padStart(4)}  ${bar}`);
  }
  console.log('');
}

async function cmdGroups() {
  console.log('\n👥 Groups\n');
  const keys = await kvList(KV.GROUPS, 'group:');
  if (keys.length === 0) { console.log('  (none)\n'); return; }

  for (const key of keys) {
    const g = await kvGet(KV.GROUPS, key);
    if (!g || typeof g !== 'object') continue;
    console.log(`  ${g.group_id}  owner=${g.owner_clawid}  members=${g.members?.length || 0}  policy=${g.policy?.send_policy || '?'}  created=${fmt(g.created_at)}`);
  }
  console.log(`\n  Total: ${keys.length} group(s)\n`);
}

async function cmdGroup(groupId) {
  if (!groupId) { console.error('Usage: admin.mjs group <group_id>'); process.exit(1); }
  console.log(`\n👥 Group: ${groupId}\n`);

  const g = await kvGet(KV.GROUPS, `group:${groupId}`);
  if (!g || typeof g !== 'object') { console.log('  Not found.'); return; }

  console.log(`  Group ID:   ${g.group_id}`);
  console.log(`  Owner:      ${g.owner_clawid}`);
  console.log(`  Created:    ${fmt(g.created_at)}`);
  console.log(`  Policy:     ${JSON.stringify(g.policy)}`);
  console.log(`  Members (${g.members?.length || 0}):`);
  for (const m of g.members || []) {
    console.log(`    - ${m.clawid}`);
  }
  console.log('');
}

async function cmdAllowlists() {
  console.log('\n🔒 Allowlists\n');
  const keys = await kvList(KV.ALLOWLISTS, 'allowlist:');
  if (keys.length === 0) { console.log('  (no allowlists configured — all users accept all senders)\n'); return; }

  for (const key of keys) {
    const clawid = key.replace('allowlist:', '');
    const list = await kvGet(KV.ALLOWLISTS, key);
    console.log(`  ${clawid}: [${Array.isArray(list) ? list.join(', ') : '?'}]`);
  }
  console.log('');
}

async function cmdDeleteUser(clawid) {
  if (!clawid) { console.error('Usage: admin.mjs delete-user <clawid>'); process.exit(1); }

  const rec = await kvGet(KV.REGISTRY, `registry:${clawid}`);
  if (!rec || typeof rec !== 'object') {
    console.error(`  User "${clawid}" not found.`);
    process.exit(1);
  }

  console.log(`\n🗑️  Deleting user: ${clawid}\n`);

  // Delete token index
  if (rec.access_token) {
    await kvDelete(KV.REGISTRY, `token:${rec.access_token}`);
    console.log(`  ✓ Token index removed`);
  }

  // Delete registry entry
  await kvDelete(KV.REGISTRY, `registry:${clawid}`);
  console.log(`  ✓ Registry entry removed`);

  // Delete pubkey history if any
  await kvDelete(KV.REGISTRY, `pubkey_history:${clawid}`);
  console.log(`  ✓ Pubkey history removed`);

  // Delete pending message index (messages themselves expire via TTL)
  await kvDelete(KV.MESSAGES, `pending:${clawid}`);
  console.log(`  ✓ Pending message index removed`);

  console.log(`\n  Done. "${clawid}" can now re-register fresh.\n`);
}

async function cmdStats() {
  console.log('\n📈 Broker Stats\n');

  const [userKeys, groupKeys, pendingKeys, msgKeys, allowlistKeys] = await Promise.all([
    kvList(KV.REGISTRY, 'registry:'),
    kvList(KV.GROUPS, 'group:'),
    kvList(KV.MESSAGES, 'pending:'),
    kvList(KV.MESSAGES, 'msg:'),
    kvList(KV.ALLOWLISTS, 'allowlist:'),
  ]);

  const pendingCounts = await Promise.all(pendingKeys.map(key => kvGet(KV.MESSAGES, key)));
  let totalPending = 0;
  for (const ids of pendingCounts) {
    if (Array.isArray(ids)) totalPending += ids.length;
  }

  // Last seen
  const userRecs = await Promise.all(userKeys.map(key => kvGet(KV.REGISTRY, key)));
  let lastActive = null;
  let lastActiveClawid = '';
  for (const rec of userRecs) {
    if (rec?.last_seen && (!lastActive || rec.last_seen > lastActive)) {
      lastActive = rec.last_seen;
      lastActiveClawid = rec.clawid;
    }
  }

  console.log(`  Registered users:    ${userKeys.length}`);
  console.log(`  Groups:              ${groupKeys.length}`);
  console.log(`  Users with pending:  ${pendingKeys.length}`);
  console.log(`  Total pending msgs:  ${totalPending}`);
  console.log(`  Stored msg objects:  ${msgKeys.length}`);
  console.log(`  Allowlists:          ${allowlistKeys.length}`);
  if (lastActive) {
    console.log(`  Last active:         ${lastActiveClawid} (${ago(lastActive)})`);
  }
  console.log('');
}

async function cmdPurge(scope) {
  const SCOPES = {
    all:       '清空所有 KV 数据（用户、消息、群组、allowlist）',
    messages:  '清空所有消息（pending 索引 + msg 对象）',
    users:     '清空所有用户注册记录（registry + token 索引）',
    groups:    '清空所有群组',
    allowlists:'清空所有 allowlist',
  };

  if (!scope || !SCOPES[scope]) {
    console.error('\n用法: admin.mjs purge <scope>\n');
    console.error('可用 scope:');
    for (const [s, desc] of Object.entries(SCOPES)) {
      console.error(`  ${s.padEnd(12)} ${desc}`);
    }
    console.error('\n⚠️  此操作不可撤销，请谨慎使用。\n');
    process.exit(1);
  }

  // Confirm via --yes flag or interactive prompt
  if (!process.argv.includes('--yes')) {
    process.stdout.write(`\n⚠️  即将执行: purge ${scope}\n   ${SCOPES[scope]}\n\n   输入 "yes" 确认: `);
    const answer = await new Promise(resolve => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', d => resolve(d.trim()));
    });
    if (answer !== 'yes') { console.log('\n  已取消。\n'); process.exit(0); }
  }

  console.log(`\n🗑️  Purging: ${scope}\n`);

  async function purgeNamespace(namespaceId, label, prefix = '') {
    const keys = await kvList(namespaceId, prefix);
    if (keys.length === 0) { console.log(`  ${label}: (空，跳过)`); return 0; }
    await kvBulkDelete(namespaceId, keys);
    console.log(`  ✓ ${label}: 删除 ${keys.length} 条`);
    return keys.length;
  }

  let total = 0;

  if (scope === 'messages' || scope === 'all') {
    total += await purgeNamespace(KV.MESSAGES, 'MESSAGES (pending + msg)', '');
  }
  if (scope === 'users' || scope === 'all') {
    // registry:* + token:* + ratelimit:* + dedup:* + pubkey_history:*
    total += await purgeNamespace(KV.REGISTRY, 'REGISTRY (users + tokens + dedup)', '');
  }
  if (scope === 'groups' || scope === 'all') {
    total += await purgeNamespace(KV.GROUPS, 'GROUPS', '');
  }
  if (scope === 'allowlists' || scope === 'all') {
    total += await purgeNamespace(KV.ALLOWLISTS, 'ALLOWLISTS', '');
  }

  console.log(`\n  完成，共删除 ${total} 条记录。\n`);
}

// ─── main ────────────────────────────────────────────────────────────────────

const HELP = `
MoltPost Broker Admin Tool

Usage: node scripts/admin.mjs <command> [args]

Commands:
  stats                        总览统计（用户数、消息数等）
  users                        注册用户列表
  user <clawid>                某用户详情（注册时间、最后在线、待消息、allowlist）
  delete-user <clawid>         删除用户注册记录，让对方可以重新注册
  messages                     所有用户的待投递消息
  pending                      各用户待拉取消息数（柱状图）
  groups                       群组列表
  group <group_id>             某群组详情（成员、策略）
  allowlists                   所有 allowlist 配置
  purge <scope> [--yes]        一键清空数据（scope: all/messages/users/groups/allowlists）
`;

const [,, cmd, arg] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
  process.exit(0);
}

try {
  switch (cmd) {
    case 'stats':       await cmdStats(); break;
    case 'users':       await cmdUsers(); break;
    case 'user':        await cmdUser(arg); break;
    case 'delete-user': await cmdDeleteUser(arg); break;
    case 'messages':    await cmdMessages(); break;
    case 'pending':    await cmdPending(); break;
    case 'groups':     await cmdGroups(); break;
    case 'group':      await cmdGroup(arg); break;
    case 'allowlists': await cmdAllowlists(); break;
    case 'purge':      await cmdPurge(arg); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
