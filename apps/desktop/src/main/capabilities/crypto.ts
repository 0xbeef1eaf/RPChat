/**
 * `sdk.crypto`: encrypt/decrypt one of the user's own files. Everything that matters — which key
 * store is in play (daemon or local, decided once at startup by `engine.ts`), the file format,
 * the encryption log, the home/system-file filter — lives in `@rp/core`'s `CryptoManager`; this
 * class only adapts it to the `CapabilityHandler` the dispatcher expects, and to the `void`
 * return the SDK typings promise (the checksums and key id are already in the log — nobody
 * scripting a character has a use for them, see `modules/crypto.ts`).
 */
import type { ActionContext, CapabilityHandler, CryptoDecryptOutcome, CryptoStatus, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { CryptoManager } from '@rp/core';

export class CryptoHandler implements CapabilityHandler {
  readonly moduleId = 'crypto';

  constructor(private readonly manager: CryptoManager) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'encrypt':
        await this.manager.encrypt(args[0]);
        return;
      case 'decrypt':
        await this.manager.decrypt(args[0]);
        return;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.crypto.${method}`);
    }
  }
}

/**
 * Settings → System → Encryption: the "user process to rotate the key" and the in-app twin of
 * `rpchat-decrypt-all`, both over the same `CryptoManager` the SDK calls go through (so a
 * rotation here is exactly what a later `sdk.crypto.encrypt` picks up, and "decrypt everything"
 * here is the same walk the standalone script does).
 */
export class CryptoService {
  constructor(
    private readonly manager: CryptoManager,
    private readonly backend: CryptoStatus['backend'],
  ) {}

  async status(): Promise<CryptoStatus> {
    // Sequential, not Promise.all: on a brand-new store, both calls would otherwise create the
    // user's first key independently. `activeKeyId` first guarantees one exists before `listKeys`
    // reads the history, so the two never disagree.
    const activeKeyId = await this.manager.activeKeyId();
    const [keys, pending] = await Promise.all([this.manager.listKeys(), this.pendingCount()]);
    return { backend: this.backend, keys, activeKeyId, pendingDecrypts: pending };
  }

  async rotateKey(): Promise<CryptoStatus> {
    await this.manager.rotateKey();
    return this.status();
  }

  async decryptAll(): Promise<CryptoDecryptOutcome[]> {
    return this.manager.decryptAll();
  }

  private async pendingCount(): Promise<number> {
    // decryptAll() would also decrypt; a status check only counts, via the same log decryptAll reads.
    return (await this.manager.listPendingPaths()).length;
  }
}
