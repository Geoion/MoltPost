/**
 * KV helpers — all key/value access in one place for tests and error handling
 */

// --- REGISTRY KV ---
// key: registry:{clawid}
// value: { clawid, pubkey, pubkey_version, access_token, last_seen, created_at, group_name? }

export async function getRegistry(env, clawid) {
  const val = await env.REGISTRY.get(`registry:${clawid}`);
  return val ? JSON.parse(val) : null;
}

export async function setRegistry(env, clawid, data, ttl) {
  const opts = ttl ? { expirationTtl: ttl } : undefined;
  await env.REGISTRY.put(`registry:${clawid}`, JSON.stringify(data), opts);
}

export async function deleteRegistry(env, clawid) {
  await env.REGISTRY.delete(`registry:${clawid}`);
}

export async function listRegistryKeys(env) {
  const list = await env.REGISTRY.list({ prefix: 'registry:' });
  return list.keys.map((k) => k.name.replace('registry:', ''));
}

// --- TOKEN INDEX KV ---
// key: token:{access_token} -> clawid (auth lookup)

export async function getTokenIndex(env, token) {
  return await env.REGISTRY.get(`token:${token}`);
}

export async function setTokenIndex(env, token, clawid, ttl) {
  const opts = ttl ? { expirationTtl: ttl } : undefined;
  await env.REGISTRY.put(`token:${token}`, clawid, opts);
}

export async function deleteTokenIndex(env, token) {
  await env.REGISTRY.delete(`token:${token}`);
}

// --- RATE LIMIT KV ---
// key: ratelimit:pull:{clawid} -> last pull timestamp
// key: ratelimit:send:{from}:{to} -> last send timestamp

export async function getPullRateLimit(env, clawid) {
  const val = await env.REGISTRY.get(`ratelimit:pull:${clawid}`);
  return val ? parseInt(val, 10) : null;
}

export async function setPullRateLimit(env, clawid, timestamp, ttl) {
  await env.REGISTRY.put(`ratelimit:pull:${clawid}`, String(timestamp), {
    expirationTtl: ttl,
  });
}

export async function getSendRateLimit(env, from, to) {
  const val = await env.REGISTRY.get(`ratelimit:send:${from}:${to}`);
  return val ? parseInt(val, 10) : null;
}

export async function setSendRateLimit(env, from, to, timestamp, ttl) {
  await env.REGISTRY.put(`ratelimit:send:${from}:${to}`, String(timestamp), {
    expirationTtl: ttl,
  });
}

// --- DEDUP KV ---
// key: dedup:{client_msg_id} -> "1" if duplicate

export async function getDedupRecord(env, clientMsgId) {
  return await env.REGISTRY.get(`dedup:${clientMsgId}`);
}

export async function setDedupRecord(env, clientMsgId, ttl) {
  await env.REGISTRY.put(`dedup:${clientMsgId}`, '1', {
    expirationTtl: ttl,
  });
}

// --- PENDING MESSAGES KV (plan B: global Queue + KV index) ---
// key: pending:{clawid} -> JSON array of message IDs

export async function getPendingIds(env, clawid) {
  const val = await env.MESSAGES.get(`pending:${clawid}`);
  return val ? JSON.parse(val) : [];
}

export async function setPendingIds(env, clawid, ids) {
  if (ids.length === 0) {
    await env.MESSAGES.delete(`pending:${clawid}`);
  } else {
    await env.MESSAGES.put(`pending:${clawid}`, JSON.stringify(ids));
  }
}

export async function appendPendingId(env, clawid, msgId) {
  const ids = await getPendingIds(env, clawid);
  ids.push(msgId);
  await setPendingIds(env, clawid, ids);
}

export async function removePendingIds(env, clawid, ackIds) {
  const ids = await getPendingIds(env, clawid);
  const remaining = ids.filter((id) => !ackIds.includes(id));
  await setPendingIds(env, clawid, remaining);
}

// --- MESSAGE STORE KV (Phase 1 in-memory; Phase 4 Queue-backed) ---
// key: msg:{msg_id} -> message object

export async function getMessage(env, msgId) {
  const val = await env.MESSAGES.get(`msg:${msgId}`);
  return val ? JSON.parse(val) : null;
}

export async function setMessage(env, msgId, data, ttl) {
  const opts = ttl ? { expirationTtl: ttl } : undefined;
  await env.MESSAGES.put(`msg:${msgId}`, JSON.stringify(data), opts);
}

export async function deleteMessage(env, msgId) {
  await env.MESSAGES.delete(`msg:${msgId}`);
}

// --- GROUPS KV ---
// key: group:{group_id} -> group object

export async function getGroup(env, groupId) {
  const val = await env.GROUPS.get(`group:${groupId}`);
  return val ? JSON.parse(val) : null;
}

export async function setGroup(env, groupId, data) {
  await env.GROUPS.put(`group:${groupId}`, JSON.stringify(data));
}

export async function deleteGroup(env, groupId) {
  await env.GROUPS.delete(`group:${groupId}`);
}

// --- ALLOWLISTS KV ---
// key: allowlist:{clawid} -> JSON array of allowed clawids

export async function getAllowlist(env, clawid) {
  const val = await env.ALLOWLISTS.get(`allowlist:${clawid}`);
  return val ? JSON.parse(val) : null;
}

export async function setAllowlist(env, clawid, list) {
  await env.ALLOWLISTS.put(`allowlist:${clawid}`, JSON.stringify(list));
}

// --- PUBKEY HISTORY KV (Phase 6: key rotation) ---
// key: pubkey_history:{clawid} -> JSON array of { pubkey, pubkey_version, rotated_at }

export async function getPubkeyHistory(env, clawid) {
  const val = await env.REGISTRY.get(`pubkey_history:${clawid}`);
  return val ? JSON.parse(val) : [];
}

export async function appendPubkeyHistory(env, clawid, pubkey, version) {
  const history = await getPubkeyHistory(env, clawid);
  history.push({
    pubkey,
    pubkey_version: version,
    rotated_at: Math.floor(Date.now() / 1000),
  });
  // Keep at most 10 historical versions
  const trimmed = history.slice(-10);
  await env.REGISTRY.put(`pubkey_history:${clawid}`, JSON.stringify(trimmed));
}

// --- INVITE TOKENS KV ---
// key: invite:{token} -> { group_id, created_at, expires_at }

export async function getInviteToken(env, token) {
  const val = await env.GROUPS.get(`invite:${token}`);
  return val ? JSON.parse(val) : null;
}

export async function setInviteToken(env, token, data, ttl) {
  const opts = ttl ? { expirationTtl: ttl } : undefined;
  await env.GROUPS.put(`invite:${token}`, JSON.stringify(data), opts);
}

export async function deleteInviteToken(env, token) {
  await env.GROUPS.delete(`invite:${token}`);
}
