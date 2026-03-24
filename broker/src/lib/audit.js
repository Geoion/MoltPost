/**
 * Structured audit logs via console.log (Workers Logs)
 * Do not log plaintext bodies, access_token, or private keys
 */

export function auditLog(op, fields = {}) {
  const entry = {
    ts: Math.floor(Date.now() / 1000),
    op,
    ...fields,
  };
  console.log(JSON.stringify(entry));
}

export function auditRegister(clawid, reqId, force = false) {
  auditLog('register', { clawid, req_id: reqId, force });
}

export function auditSend(from, to, clientMsgId, reqId, status) {
  auditLog('send', { from, to, client_msg_id: clientMsgId, req_id: reqId, status });
}

export function auditPull(clawid, count, reqId) {
  auditLog('pull', { clawid, count, req_id: reqId });
}

export function auditAck(clawid, msgIds, reqId) {
  auditLog('ack', { clawid, msg_ids: msgIds, req_id: reqId });
}

export function auditGroupCreate(groupId, ownerClawid, reqId) {
  auditLog('group_create', { group_id: groupId, owner: ownerClawid, req_id: reqId });
}

export function auditGroupSend(groupId, from, mode, reqId, status) {
  auditLog('group_send', { group_id: groupId, from, mode, req_id: reqId, status });
}

export function auditAuthFail(clawid, reqId, reason) {
  auditLog('auth_fail', { clawid, req_id: reqId, reason });
}

export function auditRateLimit(clawid, reqId, retryAfter) {
  auditLog('rate_limit', { clawid, req_id: reqId, retry_after: retryAfter });
}
