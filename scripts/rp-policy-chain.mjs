#!/usr/bin/env node
/**
 * Publish a policy chain for rp-code machines, from a terminal.
 *
 * The app does all of this under Settings → System → Remote Link → *Publish a chain*, and that is
 * the easier way. This exists for the administrator who would rather keep the signing key on a
 * build server than on a desktop, and it is also the specification: a management system in any
 * language can reimplement the four steps below.
 *
 *   1. A link is `{ seq, prev, issuedAt?, policy?, nextKey?, unseal? }`.
 *      `seq` is one more than the last link; `prev` is the SHA-256 of the last link's canonical
 *      bytes ("" for the first).
 *   2. Canonical bytes = the link without its `signature`, as compact JSON with every object's
 *      keys sorted (no spaces, no newlines).
 *   3. The signature is Ed25519 over `"rp-code-chain/v1\n" + canonical`, base64, in
 *      `{ "alg": "ed25519", "value": … }`.
 *   4. The published file is `{ "version": 1, "links": [ … ] }`. Serve at least every link from
 *      the oldest machine's position onwards; a machine walks from where it is to the end.
 *
 * A pack signature is the same key over `"rp-code-pack/v1\n<id>\n<version>\n<sha256 hex>"`.
 *
 * Usage:
 *   rp-policy-chain.mjs keygen [--out key.pem]
 *   rp-policy-chain.mjs link  --key key.pem --url https://… [--key-id acme-2026]
 *                             [--mode chain|totp] [--interval 60] [--managed-by "Acme IT"]
 *   rp-policy-chain.mjs sign  --key key.pem --chain chain.json [--policy policy.json]
 *                             [--unseal] [--rotate-to <base64 pubkey>]
 *   rp-policy-chain.mjs pack  --key key.pem --id luna [--version 1.2.0] --file luna.rppack
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const CHAIN_PREFIX = 'rp-code-chain/v1';
const PACK_PREFIX = 'rp-code-pack/v1';

/** Compact JSON with every object's keys sorted — what `serde_json` writes for the same value. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const withoutSignature = (value) => {
  const { signature: _signature, ...rest } = value;
  return rest;
};

/** The bytes a link's (or a Remote Link's) signature covers. */
export function linkMessage(value) {
  return Buffer.from(`${CHAIN_PREFIX}\n${canonicalJson(withoutSignature(value))}`, 'utf8');
}

/** The identity of a link, which the next link's `prev` names. */
export function linkHash(value) {
  return createHash('sha256').update(canonicalJson(withoutSignature(value)), 'utf8').digest('hex');
}

/** The string a pack signature covers: id, version and bytes bound together. */
export function packMessage(id, version, sha256) {
  return `${PACK_PREFIX}\n${id}\n${version ?? ''}\n${sha256.toLowerCase()}`;
}

/** Base64 of the raw 32-byte public key, which is what a machine pins. */
export function rawPublicKey(key) {
  const { x } = createPublicKey(key).export({ format: 'jwk' });
  if (!x) throw new Error('that is not an Ed25519 key');
  return Buffer.from(x, 'base64url').toString('base64');
}

/** Add `signature` to `value`, signed with `key`. */
export function signValue(value, key, keyId) {
  const signature = { alg: 'ed25519', value: sign(null, linkMessage(value), key).toString('base64') };
  if (keyId) signature.keyId = keyId;
  return { ...value, signature };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (name === 'unseal') out.unseal = true;
      else out[name] = argv[++i];
    } else out._.push(arg);
  }
  return out;
}

function readKey(args) {
  if (!args.key) throw new Error('--key <file> is required (a PKCS#8 PEM; `keygen` makes one)');
  return createPrivateKey(readFileSync(args.key, 'utf8'));
}

const COMMANDS = {
  keygen(args) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    if (args.out) {
      writeFileSync(args.out, pem, { mode: 0o600 });
      process.stderr.write(`private key written to ${args.out} (0600) — back it up; losing it strands every machine on the chain\n`);
    } else process.stdout.write(pem);
    process.stderr.write(`public key: ${rawPublicKey(privateKey)}\n`);
  },

  link(args) {
    const key = readKey(args);
    if (!args.url) throw new Error('--url <https://…> is required');
    const body = { version: 1, url: args.url, key: rawPublicKey(key), mode: args.mode ?? 'chain' };
    if (args['key-id']) body.keyId = args['key-id'];
    if (args.interval) body.intervalMinutes = Number(args.interval);
    if (args['managed-by']) body.managedBy = args['managed-by'];
    if (body.mode !== 'chain' && body.mode !== 'totp') throw new Error('--mode must be chain or totp');
    const signed = signValue(body, key, args['key-id']);
    process.stdout.write(`${Buffer.from(canonicalJson(signed), 'utf8').toString('base64')}\n`);
  },

  sign(args) {
    const key = readKey(args);
    if (!args.chain) throw new Error('--chain <file> is required (it is created if missing)');
    let chain = { version: 1, links: [] };
    try {
      chain = JSON.parse(readFileSync(args.chain, 'utf8'));
    } catch {
      // A missing chain file is the first version, not an error.
    }
    if (!args.policy && !args.unseal && !args['rotate-to']) throw new Error('a link has to do something: --policy, --rotate-to or --unseal');
    const previous = chain.links.at(-1);
    const body = { seq: (previous?.seq ?? 0) + 1, prev: previous ? linkHash(previous) : '', issuedAt: new Date().toISOString() };
    if (args.policy) body.policy = JSON.parse(readFileSync(args.policy, 'utf8'));
    if (args['rotate-to']) body.nextKey = args['rotate-to'];
    if (args.unseal) body.unseal = true;
    chain.links.push(signValue(body, key, args['key-id']));
    writeFileSync(args.chain, `${JSON.stringify(chain, null, 2)}\n`);
    process.stderr.write(`link ${body.seq} signed into ${args.chain}${args.unseal ? ' (unseals every machine on this chain)' : ''}\n`);
  },

  pack(args) {
    const key = readKey(args);
    if (!args.id || !args.file) throw new Error('--id <pack id> and --file <pack.rppack> are required');
    const sha256 = createHash('sha256').update(readFileSync(args.file)).digest('hex');
    const signature = sign(null, Buffer.from(packMessage(args.id, args.version, sha256), 'utf8'), key).toString('base64');
    process.stdout.write(`${JSON.stringify({ id: args.id, ...(args.version ? { version: args.version } : {}), sha256, signature }, null, 2)}\n`);
  },
};

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || args.help || !COMMANDS[command]) {
    process.stdout.write('usage: rp-policy-chain.mjs keygen|link|sign|pack … (see the comment at the top of this file)\n');
    return command ? 64 : 0;
  }
  COMMANDS[command](args);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`rp-policy-chain: ${err.message}\n`);
    process.exit(1);
  }
}
