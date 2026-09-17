/**
 * `sdk.crypto`: encrypt/decrypt one of the user's own files. Everything that matters — which key
 * store is in play (daemon or local, decided once at startup by `engine.ts`), the file format,
 * the encryption log, the home/system-file filter — lives in `@rp/core`'s `CryptoManager`; this
 * class only adapts it to the `CapabilityHandler` the dispatcher expects, and to the `void`
 * return the SDK typings promise (the checksums and key id are already in the log — nobody
 * scripting a character has a use for them, see `modules/crypto.ts`).
 */
import type { ActionContext, CapabilityHandler, CryptoStatus, Json } from '@rp/shared';
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
 * Settings → System → Encryption: the "user process to rotate the key", over the same
 * `CryptoManager` the SDK calls go through, so a rotation here is exactly what a later
 * `sdk.crypto.encrypt` picks up. Bulk decryption is deliberately not reachable from the
 * renderer: `rpchat-decrypt-all` (`@rp/core`) is the one way to run it, as the user, from a
 * terminal — `status().pendingDecrypts` is all this side reports about it.
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

  private async pendingCount(): Promise<number> {
    // Read-only: the same log `rpchat-decrypt-all` walks, counted rather than acted on.
    return (await this.manager.listPendingPaths()).length;
  }
}
