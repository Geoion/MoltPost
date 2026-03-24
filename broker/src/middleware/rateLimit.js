/**
 * Rate limits:
 * - /pull: min interval per ClawID (default 5 min)
 * - /send: cooldown per sender–receiver pair (default 10 s)
 */

import { getPullRateLimit, setPullRateLimit, getSendRateLimit, setSendRateLimit } from '../lib/kv.js';
import { auditRateLimit } from '../lib/audit.js';

export async function checkPullRateLimit(env, clawid, reqId) {
  const minInterval = parseInt(env.PULL_MIN_INTERVAL_SECONDS || '300', 10);
  const now = Math.floor(Date.now() / 1000);
  const lastPull = await getPullRateLimit(env, clawid);

  if (lastPull !== null) {
    const elapsed = now - lastPull;
    if (elapsed < minInterval) {
      const retryAfter = minInterval - elapsed;
      auditRateLimit(clawid, reqId, retryAfter);
      return {
        limited: true,
        retryAfter,
        response: new Response(
          JSON.stringify({ error: 'Too Many Requests', retry_after: retryAfter }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfter),
            },
          }
        ),
      };
    }
  }

  await setPullRateLimit(env, clawid, now, minInterval * 2);
  return { limited: false };
}

export async function checkSendRateLimit(env, from, to, reqId) {
  const cooldown = parseInt(env.SEND_RATE_LIMIT_SECONDS || '10', 10);
  const now = Math.floor(Date.now() / 1000);
  const lastSend = await getSendRateLimit(env, from, to);

  if (lastSend !== null) {
    const elapsed = now - lastSend;
    if (elapsed < cooldown) {
      const retryAfter = cooldown - elapsed;
      auditRateLimit(from, reqId, retryAfter);
      return {
        limited: true,
        retryAfter,
        response: new Response(
          JSON.stringify({ error: 'Too Many Requests', retry_after: retryAfter }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfter),
            },
          }
        ),
      };
    }
  }

  // KV TTL minimum is 60 seconds
  const ttl = Math.max(cooldown * 2, 60);
  await setSendRateLimit(env, from, to, now, ttl);
  return { limited: false };
}
