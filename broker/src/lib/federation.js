/**
 * Federation: cross-broker routing
 * When payload includes target_broker, forward to that broker's /send without reading plaintext
 */

/**
 * Forward message to remote broker
 * @param {string} targetBrokerUrl
 * @param {object} payload
 * @param {string} reqId
 */
export async function forwardToRemoteBroker(targetBrokerUrl, payload, reqId) {
  const url = `${targetBrokerUrl.replace(/\/$/, '')}/send`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': reqId,
      'X-Forwarded-By': 'moltpost-federation',
    },
    body: JSON.stringify(payload),
  });

  return {
    status: res.status,
    data: await res.json().catch(() => ({})),
  };
}

/**
 * Fetch broker capability document
 * @param {string} brokerUrl
 */
export async function discoverBroker(brokerUrl) {
  try {
    const res = await fetch(`${brokerUrl.replace(/\/$/, '')}/.well-known/moltpost`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 200) {
      return await res.json();
    }
    return null;
  } catch {
    return null;
  }
}
