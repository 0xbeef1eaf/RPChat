/**
 * Renderer-facing shapes for Settings → System → Encryption (`sdk.crypto`). The key material
 * itself never appears here — only ids, timestamps and counts — see `CryptoKeyRecord` in
 * `system.ts` for the (daemon-only, key-bearing) protocol type.
 */
export interface CryptoStatus {
  /** Where the key history lives: the system daemon (`rpchatd`) or the app's own config. */
  backend: 'daemon' | 'local';
  /** Every key this user has ever had, oldest first, without key material. */
  keys: Array<{ id: string; createdAt: string }>;
  /** The key `encrypt` uses right now. */
  activeKeyId: string;
  /** Encrypted files the log has not seen a matching `decrypt` for yet. */
  pendingDecrypts: number;
}

/** One file `decryptAll` looked at. */
export interface CryptoDecryptOutcome {
  path: string;
  ok: boolean;
  reason?: string;
}
