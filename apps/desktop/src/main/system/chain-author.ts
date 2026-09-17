/**
 * The **authoring** side of a policy chain: generating the signing key, handing out the Remote
 * Link, and signing each new version of the policy.
 *
 * Every other part of this feature is about a machine *being* managed. This is the other half —
 * the person doing the managing — and it lives in the app because that is where the policy is
 * already written (Settings → System → *Create policy*). Without it an administrator would have
 * to leave the app, run a Node script, and hand-edit JSON to produce something the app could then
 * be given back.
 *
 * What it holds:
 *
 * - **The private key**, in `<userData>/policy-chain/key.bin`, encrypted through the OS keyring
 *   (`safeStorage`) where there is one and written `0600` where there is not — the same treatment
 *   the update token gets. It is never logged, never in the settings JSON, and never leaves the
 *   main process except as an explicit export the administrator asked for.
 * - **The chain being built**, in `<userData>/policy-chain/chain.json`. Keeping it means a new
 *   version is one button — the previous link's hash and `seq` are already known — instead of
 *   bookkeeping the administrator has to get right by hand.
 *
 * The signing itself is Node's Ed25519 (`crypto.sign(null, …)`), over exactly the bytes
 * `native/rpchatd/src/chain.rs` verifies: `rpchat-chain/v1\n` followed by the link's canonical
 * JSON. `canonicalJson` here and `serde_json` there produce the same bytes for the same value.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { ChainAuthorStatus, ChainLink, PolicyChain, PolicyFile, RemoteLink, SealMode } from '@rp/shared';
import { RpError } from '@rp/shared';
import { canonicalJson } from './seal-cache.js';

/** Prefixed to a link's canonical bytes before signing (`chain.rs`). */
export const CHAIN_SIGNING_PREFIX = 'rpchat-chain/v1';
/** The string a pack signature covers (`remote.rs`). */
export const PACK_SIGNING_PREFIX = 'rpchat-pack/v1';
/** Marks a key file that went through the OS keyring, so a fallback file is not fed to it. */
const HEADER_KEYRING = 'rp-chain-key:v1:keyring\n';
const HEADER_PLAIN = 'rp-chain-key:v1:plain\n';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface ChainAuthorDeps {
  dir: string;
  safeStorage: SafeStorageLike;
  logger: Pick<Console, 'info' | 'warn'>;
  now?: () => Date;
}

/** The settings an administrator gives their chain once; kept beside it. */
export interface ChainSettings {
  url: string;
  keyId?: string;
  intervalMinutes?: number;
  managedBy?: string;
  mode: SealMode;
}

interface ChainFile {
  version: 1;
  settings: ChainSettings;
  links: ChainLink[];
}

/** The bytes a link's signature covers. */
export function linkMessage(link: unknown): Buffer {
  return Buffer.from(`${CHAIN_SIGNING_PREFIX}\n${canonicalJson(stripSignature(link))}`, 'utf8');
}

/** The identity of a link: SHA-256 of its canonical bytes, which the next link's `prev` names. */
export function linkHash(link: unknown): string {
  return createHash('sha256').update(canonicalJson(stripSignature(link)), 'utf8').digest('hex');
}

/** The string a pack signature covers: id, version and bytes bound together. */
export function packMessage(id: string, version: string | undefined, sha256: string): string {
  return `${PACK_SIGNING_PREFIX}\n${id}\n${version ?? ''}\n${sha256.toLowerCase()}`;
}

function stripSignature(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { signature: _signature, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Base64 of an Ed25519 public key's raw 32 bytes, which is what a machine pins. */
export function rawPublicKey(key: KeyObject): string {
  // `jwk` gives the raw key without the DER wrapper, base64url; the wire format is standard base64.
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new RpError('CAPABILITY_FAILED', 'that key is not an Ed25519 public key');
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

export class ChainAuthor {
  private readonly now: () => Date;

  constructor(private readonly deps: ChainAuthorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get keyPath(): string {
    return path.join(this.deps.dir, 'key.bin');
  }

  private get chainPath(): string {
    return path.join(this.deps.dir, 'chain.json');
  }

  async status(): Promise<ChainAuthorStatus> {
    const key = await this.readKey().catch(() => null);
    const chain = await this.readChain();
    const out: ChainAuthorStatus = {
      hasKey: key !== null,
      keyring: this.deps.safeStorage.isEncryptionAvailable(),
      links: chain?.links.length ?? 0,
      seq: chain?.links.at(-1)?.seq ?? 0,
      mode: chain?.settings.mode ?? 'chain',
      dir: this.deps.dir,
    };
    if (key) out.publicKey = rawPublicKey(createPublicKey(key));
    const last = chain?.links.at(-1);
    if (last) out.head = linkHash(last);
    if (chain?.settings.url) out.url = chain.settings.url;
    if (chain?.settings.keyId) out.keyId = chain.settings.keyId;
    if (chain?.settings.managedBy) out.managedBy = chain.settings.managedBy;
    return out;
  }

  /**
   * Make a signing key. Refuses to replace one that exists unless `replace` is set: overwriting
   * it orphans every machine already following this chain, since nothing they will accept can be
   * signed any more.
   */
  async createKey(replace = false): Promise<ChainAuthorStatus> {
    if (!replace && (await this.readKey().catch(() => null))) {
      throw new RpError('INVALID_ARGUMENT', 'A signing key already exists. Replacing it orphans every machine already following this chain — rotate through a link instead.');
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    await this.writeKey(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    this.deps.logger.info(`[chain] a new policy-chain signing key was generated in ${this.deps.dir}`);
    return this.status();
  }

  /** Take over an existing key (a PKCS#8 PEM), so a chain survives moving between machines. */
  async importKey(pem: string): Promise<ChainAuthorStatus> {
    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch (err) {
      throw new RpError('INVALID_ARGUMENT', `That is not a private key in PEM form: ${(err as Error).message}`);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new RpError('INVALID_ARGUMENT', `That is a ${key.asymmetricKeyType ?? 'unknown'} key; a policy chain is signed with Ed25519.`);
    await this.writeKey(key.export({ format: 'pem', type: 'pkcs8' }).toString());
    this.deps.logger.info('[chain] a policy-chain signing key was imported');
    return this.status();
  }

  /** The private key as PEM, for the administrator to back up. Only ever on explicit request. */
  async exportKey(): Promise<string> {
    const pem = await this.readKey();
    if (!pem) throw new RpError('NOT_FOUND', 'There is no signing key in this app yet.');
    return pem;
  }

  /** Forget the key and the chain. The machines already following it are unaffected — and stuck. */
  async forget(): Promise<ChainAuthorStatus> {
    await fs.rm(this.keyPath, { force: true });
    await fs.rm(this.chainPath, { force: true });
    this.deps.logger.warn('[chain] the policy-chain signing key and chain were removed from this app');
    return this.status();
  }

  /** Where the chain is published and how it is described; also decides the Remote Link's mode. */
  async configure(settings: Partial<ChainSettings>): Promise<ChainAuthorStatus> {
    const chain = (await this.readChain()) ?? { version: 1 as const, settings: { url: '', mode: 'chain' as SealMode }, links: [] };
    const next: ChainSettings = { ...chain.settings, ...definedOnly(settings) };
    if (next.url && !/^https:\/\/.|^http:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(next.url)) {
      throw new RpError('INVALID_ARGUMENT', 'The address must be https:// (plain http is only allowed on 127.0.0.1).');
    }
    await this.writeChain({ ...chain, settings: next });
    return this.status();
  }

  /**
   * The Remote Link blob to hand out. Self-signed with the chain key, so a machine can tell that
   * what it was pasted is what was published — the blob travels through chat apps and ticketing
   * systems, and those mangle things.
   */
  async remoteLink(): Promise<{ blob: string; link: RemoteLink }> {
    const pem = await this.readKey();
    if (!pem) throw new RpError('NOT_FOUND', 'Generate or import a signing key first.');
    const chain = await this.readChain();
    if (!chain?.settings.url) throw new RpError('INVALID_ARGUMENT', 'Set the address the chain will be published at first.');
    const key = createPrivateKey(pem);
    const body: Record<string, unknown> = {
      version: 1,
      url: chain.settings.url,
      key: rawPublicKey(createPublicKey(key)),
      mode: chain.settings.mode,
    };
    if (chain.settings.keyId) body.keyId = chain.settings.keyId;
    if (chain.settings.intervalMinutes !== undefined) body.intervalMinutes = chain.settings.intervalMinutes;
    if (chain.settings.managedBy) body.managedBy = chain.settings.managedBy;
    const signed = { ...body, signature: { alg: 'ed25519' as const, value: this.signValue(key, body) } };
    return { blob: Buffer.from(canonicalJson(signed), 'utf8').toString('base64'), link: signed as unknown as RemoteLink };
  }

  /**
   * Add a version to the chain: a new link carrying `policy`, hash-linked to the last one and
   * signed. `unseal` releases every machine following the chain; `rotateTo` hands the chain to
   * another key, signed by the one it replaces.
   */
  async appendLink(input: { policy?: PolicyFile; unseal?: boolean; rotateTo?: string }): Promise<{ status: ChainAuthorStatus; link: ChainLink }> {
    const pem = await this.readKey();
    if (!pem) throw new RpError('NOT_FOUND', 'Generate or import a signing key first.');
    if (!input.policy && !input.unseal && !input.rotateTo) {
      throw new RpError('INVALID_ARGUMENT', 'A link has to do something: carry a policy, rotate the key, or unseal.');
    }
    const chain = (await this.readChain()) ?? { version: 1 as const, settings: { url: '', mode: 'chain' as SealMode }, links: [] };
    const previous = chain.links.at(-1);
    const body: Record<string, unknown> = {
      seq: (previous?.seq ?? 0) + 1,
      prev: previous ? linkHash(previous) : '',
      issuedAt: this.now().toISOString(),
    };
    if (input.policy) body.policy = input.policy;
    if (input.rotateTo) body.nextKey = input.rotateTo;
    if (input.unseal) body.unseal = true;
    const key = createPrivateKey(pem);
    const signature: ChainLink['signature'] = { alg: 'ed25519', value: this.signValue(key, body) };
    if (chain.settings.keyId) signature.keyId = chain.settings.keyId;
    const link = { ...body, signature } as unknown as ChainLink;
    await this.writeChain({ ...chain, links: [...chain.links, link] });
    this.deps.logger.info(`[chain] link ${link.seq} signed${input.unseal ? ' (unseals)' : ''}${input.rotateTo ? ' (rotates the key)' : ''}`);
    return { status: await this.status(), link };
  }

  /** Sign a pack file the administrator is publishing, so machines will install it. */
  async signPack(input: { id: string; version?: string; sha256: string }): Promise<string> {
    const pem = await this.readKey();
    if (!pem) throw new RpError('NOT_FOUND', 'Generate or import a signing key first.');
    if (!/^[0-9a-f]{64}$/i.test(input.sha256)) throw new RpError('INVALID_ARGUMENT', 'The checksum must be 64 hex characters.');
    const message = Buffer.from(packMessage(input.id, input.version, input.sha256), 'utf8');
    return signBytes(null, message, createPrivateKey(pem)).toString('base64');
  }

  /** The chain file as it would be published. */
  async publishedChain(): Promise<PolicyChain> {
    const chain = await this.readChain();
    return { version: 1, links: chain?.links ?? [] };
  }

  /** Drop the last link — an undo for a version signed by mistake and not yet published. */
  async dropLastLink(): Promise<ChainAuthorStatus> {
    const chain = await this.readChain();
    if (!chain || chain.links.length === 0) throw new RpError('NOT_FOUND', 'There are no links to remove.');
    await this.writeChain({ ...chain, links: chain.links.slice(0, -1) });
    this.deps.logger.warn('[chain] the last link was dropped; if it was already published, machines that took it are ahead of this chain');
    return this.status();
  }

  private signValue(key: KeyObject, body: unknown): string {
    return signBytes(null, linkMessage(body), key).toString('base64');
  }

  private async readChain(): Promise<ChainFile | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.chainPath, 'utf8')) as ChainFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.links)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeChain(chain: ChainFile): Promise<void> {
    await fs.mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.chainPath, `${JSON.stringify(chain, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private async writeKey(pem: string): Promise<void> {
    await fs.mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
    if (this.deps.safeStorage.isEncryptionAvailable()) {
      const encrypted = this.deps.safeStorage.encryptString(pem);
      await fs.writeFile(this.keyPath, Buffer.concat([Buffer.from(HEADER_KEYRING, 'utf8'), encrypted]), { mode: 0o600 });
      return;
    }
    this.deps.logger.warn('[chain] no OS keyring is available, so the signing key is stored as a 0600 file');
    await fs.writeFile(this.keyPath, `${HEADER_PLAIN}${pem}`, { encoding: 'utf8', mode: 0o600 });
  }

  private async readKey(): Promise<string | null> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.keyPath);
    } catch {
      return null;
    }
    const text = raw.toString('utf8');
    if (text.startsWith(HEADER_PLAIN)) return text.slice(HEADER_PLAIN.length);
    if (text.startsWith(HEADER_KEYRING)) {
      if (!this.deps.safeStorage.isEncryptionAvailable()) {
        throw new RpError('CAPABILITY_FAILED', 'The signing key was stored through the OS keyring, which is not available now.');
      }
      return this.deps.safeStorage.decryptString(raw.subarray(Buffer.byteLength(HEADER_KEYRING)));
    }
    throw new RpError('CAPABILITY_FAILED', `${this.keyPath} is not a key file this app wrote.`);
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
