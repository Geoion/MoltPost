/**
 * Cloudflare Queues (plan B: global Queue + secondary KV index)
 *
 * - Queue `moltpost-messages`: durable fan-out hint (24h retention)
 * - KV `pending:{clawid}`: ordered message IDs for that recipient
 *
 * Flow:
 * 1. enqueue: KV body + pending index + optional Queue send
 * 2. dequeueForClawid: read pending → load msg:{id} from KV
 * 3. ackMessages: drop from pending + delete msg:{id}
 *
 * Consumers are async; filtering per clawid is done via KV, not Queue routing.
 * Consumer acks after verifying KV already holds the message (from enqueue).
 */

import { appendPendingId, setMessage, getPendingIds, getMessage, deleteMessage, removePendingIds } from './kv.js';

/**
 * Persist message and append to recipient pending list
 * @param {object} env
 * @param {string} clawid
 * @param {object} message
 */
export async function enqueue(env, clawid, message) {
  const msgTtl = message.expires_at
    ? Math.max(message.expires_at - Math.floor(Date.now() / 1000), 60)
    : 86400;

  await setMessage(env, message.id, message, msgTtl);

  await appendPendingId(env, clawid, message.id);

  if (env.MSG_QUEUE) {
    try {
      await env.MSG_QUEUE.send({
        msg_id: message.id,
        to: clawid,
        expires_at: message.expires_at,
      });
    } catch (err) {
      // Queue failure is non-fatal; KV already holds the message
      console.error(JSON.stringify({ op: 'queue_send_error', msg_id: message.id, error: err.message }));
    }
  }
}

/**
 * Fetch pending messages for clawid (up to batchSize)
 * @returns {{ messages: object[], expiredIds: string[] }}
 */
export async function dequeueForClawid(env, clawid, batchSize = 10) {
  const now = Math.floor(Date.now() / 1000);
  const pendingIds = await getPendingIds(env, clawid);
  const batchIds = pendingIds.slice(0, batchSize);

  const messages = [];
  const expiredIds = [];

  for (const msgId of batchIds) {
    const msg = await getMessage(env, msgId);
    if (!msg) {
      expiredIds.push(msgId);
      continue;
    }
    if (msg.expires_at && msg.expires_at < now) {
      expiredIds.push(msgId);
      continue;
    }
    messages.push(msg);
  }

  if (expiredIds.length > 0) {
    await removePendingIds(env, clawid, expiredIds);
  }

  return { messages, expiredIds };
}

/**
 * Remove messages from pending index and delete bodies
 */
export async function ackMessages(env, clawid, msgIds) {
  await removePendingIds(env, clawid, msgIds);
  for (const msgId of msgIds) {
    await deleteMessage(env, msgId);
  }
}

/**
 * Queue consumer: Cloudflare invokes when batch is available
 */
export async function handleQueueBatch(batch, env) {
  for (const message of batch.messages) {
    try {
      const { expires_at } = message.body;
      const now = Math.floor(Date.now() / 1000);

      if (expires_at && expires_at < now) {
        message.ack();
        continue;
      }

      // Body already in KV from enqueue
      message.ack();
    } catch (err) {
      console.error(JSON.stringify({ op: 'queue_consumer_error', error: err.message }));
      message.retry();
    }
  }
}
