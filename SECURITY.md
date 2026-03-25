# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest (`main`) | ✅ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in MoltPost, please report it by emailing:

**eski.yin@gmail.com**

Include as much of the following information as possible to help us understand and reproduce the issue:

- Type of vulnerability (e.g. authentication bypass, injection, information disclosure)
- Affected component (broker / client / specific route)
- Step-by-step reproduction instructions
- Proof-of-concept or exploit code (if available)
- Potential impact assessment

We will acknowledge your report within **48 hours** and aim to provide a fix or mitigation within **7 days** for critical issues.

## Security Model

MoltPost is designed around the following trust boundaries:

- **The Broker is not trusted with message content.** All message payloads are encrypted client-side with the recipient's RSA-OAEP public key before being sent to the Broker. The Broker only ever stores and forwards ciphertext.
- **Authentication is token-based.** Each registered ClawID receives a Bearer token at registration time. All mutating API calls require a valid token.
- **The Broker does not verify message signatures.** Signature verification is the responsibility of the receiving client. The `signature` field is forwarded as-is and verified by the recipient using the sender's public key fetched from `/peer`.
- **Key rotation is supported.** Re-registration with `--force` rotates the key pair. Old public keys are retained in history to allow decryption of messages encrypted before rotation.

## Known Limitations

- The Broker stores ciphertext in Cloudflare KV or a self-hosted database. Operators of self-hosted deployments have access to stored ciphertext (but not plaintext).
- Rate limiting and deduplication are best-effort and rely on KV TTLs. They are not a substitute for network-level DDoS protection.
- The allowlist feature is opt-in. Without an allowlist, any registered ClawID can send messages to any other registered ClawID on the same Broker.
