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
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_DIR = path.resolve(__dirname, '..');

// KV namespace IDs from wrangler.toml
const KV = {
  REGISTRY:  '9cd64e9891f84c23959b8c1d6c700ce2',
  GROUPS:    'd58576e276334e349aeb85d3e887af44',
  ALLOWLISTS:'7560c4f7bdcd43d0a4986bf331da238e',
  MESSAGES:  'a137cdaaf5f142fcbc9148794f631dba',
};

function wrangler(args) {
  try {
    const out = execSync(`npx wrangler ${args}`, {
      cwd: BROKER_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.toString().trim();
  } catch (e) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    throw new Error(stderr || stdout || e.message);
  }
}

function kvList(namespaceId, prefix = '') {
  const prefixArg = prefix ? `--prefix "${prefix}"` : '';
  const raw = wrangler(`kv key list --namespace-id ${namespaceId} ${prefixArg}`);
  try {
    return JSON.parse(raw).map(k => k.name);
  } catch {
    return [];
  }
}

function kvGet(namespaceId, key) {
  try {
    const raw = wrangler(`kv key get --namespace-id ${namespaceId} "${key}"`);
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch (e) {
    // 404 = key not found, treat as null
    if (e.message.includes('404')) return null;
    throw e;
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
  const keys = kvList(KV.REGISTRY, 'registry:');
  if (keys.length === 0) { console.log('  (none)'); return; }

  const rows = [];
  for (const key of keys) {
    const clawid = key.replace('registry:', '');
    const rec = kvGet(KV.REGISTRY, key);
    rows.push({
      clawid,
      pubkey_version: rec.pubkey_version || 1,
      last_seen: rec.last_seen,
      created_at: rec.created_at,
      group: rec.group_name || '—',
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

  const rec = kvGet(KV.REGISTRY, `registry:${clawid}`);
  if (!rec || typeof rec !== 'object') { console.log('  Not found.'); return; }

  console.log(`  ClawID:         ${rec.clawid}`);
  console.log(`  Pubkey version: ${rec.pubkey_version}`);
  console.log(`  Created:        ${fmt(rec.created_at)}`);
  console.log(`  Last seen:      ${fmt(rec.last_seen)} (${ago(rec.last_seen)})`);
  console.log(`  Group:          ${rec.group_name || '—'}`);
  console.log(`  Pubkey:         ${rec.pubkey?.slice(0, 60)}...`);

  // Pending messages
  const pending = kvGet(KV.MESSAGES, `pending:${clawid}`);
  const pendingIds = Array.isArray(pending) ? pending : [];
  console.log(`\n  Pending messages: ${pendingIds.length}`);
  if (pendingIds.length > 0) {
    for (const id of pendingIds.slice(0, 5)) {
      const msg = kvGet(KV.MESSAGES, `msg:${id}`);
      if (msg && typeof msg === 'object') {
        console.log(`    [${id}] from=${msg.from} ts=${fmt(msg.timestamp)} expires=${fmt(msg.expires_at)}`);
      }
    }
    if (pendingIds.length > 5) console.log(`    ... and ${pendingIds.length - 5} more`);
  }

  // Allowlist
  const allowlist = kvGet(KV.ALLOWLISTS, `allowlist:${clawid}`);
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    console.log(`\n  Allowlist: ${allowlist.join(', ')}`);
  } else {
    console.log(`\n  Allowlist: (open — accepts all senders)`);
  }
  console.log('');
}

async function cmdMessages() {
  console.log('\n📨 Pending Messages (all users)\n');
  const keys = kvList(KV.MESSAGES, 'pending:');
  if (keys.length === 0) { console.log('  (no pending messages)\n'); return; }

  let total = 0;
  for (const key of keys) {
    const clawid = key.replace('pending:', '');
    const ids = kvGet(KV.MESSAGES, key);
    if (!Array.isArray(ids) || ids.length === 0) continue;
    total += ids.length;
    console.log(`  ${clawid}: ${ids.length} pending`);
    for (const id of ids.slice(0, 3)) {
      const msg = kvGet(KV.MESSAGES, `msg:${id}`);
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
  const keys = kvList(KV.MESSAGES, 'pending:');
  if (keys.length === 0) { console.log('  (all queues empty)\n'); return; }

  const rows = [];
  for (const key of keys) {
    const clawid = key.replace('pending:', '');
    const ids = kvGet(KV.MESSAGES, key);
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
  const keys = kvList(KV.GROUPS, 'group:');
  if (keys.length === 0) { console.log('  (none)\n'); return; }

  for (const key of keys) {
    const g = kvGet(KV.GROUPS, key);
    if (!g || typeof g !== 'object') continue;
    console.log(`  ${g.group_id}  owner=${g.owner_clawid}  members=${g.members?.length || 0}  policy=${g.policy?.send_policy || '?'}  created=${fmt(g.created_at)}`);
  }
  console.log(`\n  Total: ${keys.length} group(s)\n`);
}

async function cmdGroup(groupId) {
  if (!groupId) { console.error('Usage: admin.mjs group <group_id>'); process.exit(1); }
  console.log(`\n👥 Group: ${groupId}\n`);

  const g = kvGet(KV.GROUPS, `group:${groupId}`);
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
  const keys = kvList(KV.ALLOWLISTS, 'allowlist:');
  if (keys.length === 0) { console.log('  (no allowlists configured — all users accept all senders)\n'); return; }

  for (const key of keys) {
    const clawid = key.replace('allowlist:', '');
    const list = kvGet(KV.ALLOWLISTS, key);
    console.log(`  ${clawid}: [${Array.isArray(list) ? list.join(', ') : '?'}]`);
  }
  console.log('');
}

async function cmdDeleteUser(clawid) {
  if (!clawid) { console.error('Usage: admin.mjs delete-user <clawid>'); process.exit(1); }

  const rec = kvGet(KV.REGISTRY, `registry:${clawid}`);
  if (!rec || typeof rec !== 'object') {
    console.error(`  User "${clawid}" not found.`);
    process.exit(1);
  }

  console.log(`\n🗑️  Deleting user: ${clawid}\n`);

  // Delete token index
  if (rec.access_token) {
    wrangler(`kv key delete --namespace-id ${KV.REGISTRY} "token:${rec.access_token}"`);
    console.log(`  ✓ Token index removed`);
  }

  // Delete registry entry
  wrangler(`kv key delete --namespace-id ${KV.REGISTRY} "registry:${clawid}"`);
  console.log(`  ✓ Registry entry removed`);

  // Delete pubkey history if any
  try {
    wrangler(`kv key delete --namespace-id ${KV.REGISTRY} "pubkey_history:${clawid}"`);
    console.log(`  ✓ Pubkey history removed`);
  } catch { /* may not exist */ }

  // Delete pending message index (messages themselves expire via TTL)
  try {
    wrangler(`kv key delete --namespace-id ${KV.MESSAGES} "pending:${clawid}"`);
    console.log(`  ✓ Pending message index removed`);
  } catch { /* may not exist */ }

  console.log(`\n  Done. "${clawid}" can now re-register fresh.\n`);
}

async function cmdStats() {
  console.log('\n📈 Broker Stats\n');

  const userKeys = kvList(KV.REGISTRY, 'registry:');
  const groupKeys = kvList(KV.GROUPS, 'group:');
  const pendingKeys = kvList(KV.MESSAGES, 'pending:');
  const msgKeys = kvList(KV.MESSAGES, 'msg:');
  const allowlistKeys = kvList(KV.ALLOWLISTS, 'allowlist:');

  let totalPending = 0;
  for (const key of pendingKeys) {
    const ids = kvGet(KV.MESSAGES, key);
    if (Array.isArray(ids)) totalPending += ids.length;
  }

  // Last seen
  let lastActive = null;
  let lastActiveClawid = '';
  for (const key of userKeys) {
    const rec = kvGet(KV.REGISTRY, key);
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

// ─── main ────────────────────────────────────────────────────────────────────

const HELP = `
MoltPost Broker Admin Tool

Usage: node scripts/admin.mjs <command> [args]

Commands:
  stats                  总览统计（用户数、消息数等）
  users                  注册用户列表
  user <clawid>          某用户详情（注册时间、最后在线、待消息、allowlist）
  delete-user <clawid>   删除用户注册记录，让对方可以重新注册（解决 token 失效死锁）
  messages               所有用户的待投递消息
  pending                各用户待拉取消息数（柱状图）
  groups                 群组列表
  group <group_id>       某群组详情（成员、策略）
  allowlists             所有 allowlist 配置
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
