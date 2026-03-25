#!/usr/bin/env node
/**
 * Create Cloudflare KV namespaces + queue for the broker and update wrangler.toml
 * (via wrangler --update-config). Run from repo root or broker/; uses broker/wrangler.toml.
 *
 * Usage: node scripts/provision.mjs
 *    or: npm run provision   (from broker/)
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_DIR = path.resolve(__dirname, '..');
const WRANGLER_REL = 'wrangler.toml';
const REQUIRED_KV = ['REGISTRY', 'GROUPS', 'ALLOWLISTS', 'MESSAGES'];
const QUEUE_NAME = 'moltpost-messages';

function parseKvState(content) {
  /** @type {Record<string, { id?: string; preview_id?: string }>} */
  const byBinding = {};
  const parts = content.split('[[kv_namespaces]]');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].split(/\[\[/)[0];
    const binding = block.match(/binding\s*=\s*"([^"]+)"/)?.[1];
    if (!binding) continue;
    const id = block.match(/^\s*id\s*=\s*"([^"]*)"/m)?.[1];
    const preview_id = block.match(/^\s*preview_id\s*=\s*"([^"]*)"/m)?.[1];
    byBinding[binding] = { id, preview_id };
  }
  return byBinding;
}

function isNamespaceId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
}

function readTomlKv() {
  const content = readFileSync(path.join(BROKER_DIR, WRANGLER_REL), 'utf8');
  return parseKvState(content);
}

function isAuthenticated() {
  const r = spawnSync('npx', ['wrangler', 'whoami', '--json'], {
    cwd: BROKER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
}

function ensureAuthenticated() {
  if (isAuthenticated()) return;

  console.log('Not logged in to Cloudflare. Starting wrangler login...\n');
  const login = spawnSync('npx', ['wrangler', 'login'], {
    cwd: BROKER_DIR,
    stdio: 'inherit',
  });
  if (login.status !== 0) {
    console.error('\nwrangler login did not complete successfully.');
    process.exit(1);
  }

  if (!isAuthenticated()) {
    console.error('\nStill not authenticated after login. Try again or check your Cloudflare account.');
    process.exit(1);
  }
  console.log('\nLogin OK. Continuing with provisioning...\n');
}

/**
 * @param {string[]} args wrangler subcommand + flags (no "wrangler" prefix)
 */
function runWrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd: BROKER_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function provisionKv() {
  for (const binding of REQUIRED_KV) {
    let state = readTomlKv()[binding] || {};

    if (!isNamespaceId(state.id)) {
      const title = `moltpost-broker-${binding.toLowerCase()}`;
      console.log(`Creating KV namespace (production): ${binding} (${title})...`);
      runWrangler([
        'kv',
        'namespace',
        'create',
        title,
        '--binding',
        binding,
        '--update-config',
        '-c',
        WRANGLER_REL,
      ]);
    } else {
      console.log(`KV ${binding}: production id already set, skipping create.`);
    }

    state = readTomlKv()[binding] || {};
    if (!isNamespaceId(state.preview_id)) {
      const previewTitle = `moltpost-broker-${binding.toLowerCase()}-preview`;
      console.log(`Creating KV namespace (preview): ${binding} (${previewTitle})...`);
      runWrangler([
        'kv',
        'namespace',
        'create',
        previewTitle,
        '--binding',
        binding,
        '--preview',
        '--update-config',
        '-c',
        WRANGLER_REL,
      ]);
    } else {
      console.log(`KV ${binding}: preview_id already set, skipping create.`);
    }
  }
}

function provisionQueue() {
  console.log(`Creating queue "${QUEUE_NAME}" (if it does not exist)...`);
  const r = spawnSync('npx', ['wrangler', 'queues', 'create', QUEUE_NAME], {
    cwd: BROKER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const combined = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (r.status === 0) {
    if (combined.trim()) console.log(combined.trim());
    console.log('');
    return;
  }
  if (
    /already exists|already been created|already taken|duplicate|\b409\b|11009/i.test(
      combined,
    )
  ) {
    console.log('Queue already exists, skipping.\n');
    return;
  }
  process.stderr.write(combined);
  process.exit(r.status ?? 1);
}

function main() {
  ensureAuthenticated();
  console.log('Provisioning broker resources (KV + queue)...\n');
  provisionKv();
  provisionQueue();
  console.log('Done. Next: cd broker && npm run deploy');
}

main();
