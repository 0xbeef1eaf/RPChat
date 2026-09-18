/**
 * Settings → System → **Remote Link**: the two sides of a managed fleet in one card.
 *
 * *Following* is the paste box: a base64 blob an administrator handed out, which points this
 * machine at a policy chain and seals it in the mode the blob names. Pasting the first one is
 * free; replacing it is exactly as serious as replacing the policy, so a machine held by a code
 * asks for one and a machine held by a chain refuses — only its own chain can move it.
 *
 * *Publishing* is the other half, and it is here because this is where policies are written. It
 * generates the signing key, hands out the Remote Link, and signs each new version of the policy
 * as a link in the chain. The private key never leaves the main process except as a backup the
 * administrator explicitly asks for.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChainAuthorStatus, PolicyFile, SystemIntegrationStatus } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime, prettyJson } from '../../lib/format';
import { CodeEditor } from '../common/CodeEditor';
import { toast } from '../../store/actions';
import { Modal } from '../common/Modal';
import { QrCode } from '../common/QrCode';
import { CodeDialog } from './SealSection';

/** Pure: what the publishing side currently amounts to, as a sentence. */
export function authorLine(author: ChainAuthorStatus): string {
  if (!author.hasKey) return 'No signing key here. Generate one to publish a policy chain that other machines follow.';
  const where = author.url ? ` published at ${author.url}` : ' (no address set yet)';
  const at = author.links === 0 ? 'no versions signed yet' : `${author.links} version${author.links === 1 ? '' : 's'}, latest ${author.seq}`;
  return `Signing key ready${author.keyring ? '' : ' (stored as a file — this machine has no keyring)'} — ${at}${where}.`;
}

export function RemoteLinkCard({ status, onChanged, disabled }: { status: SystemIntegrationStatus; onChanged(next: SystemIntegrationStatus): void; disabled?: boolean }) {
  const remote = status.remote?.daemon;
  const seal = status.policy.seal;
  const [pasting, setPasting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [blob, setBlob] = useState('');
  const [pendingCode, setPendingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauth: string } | null>(null);

  const apply = async (code?: string) => {
    setBusy(true);
    try {
      const res = await api().system.setRemoteLink(blob.trim(), code);
      onChanged(res.status);
      setPasting(false);
      setPendingCode(false);
      setBlob('');
      if (res.secret && res.otpauth) setEnrolment({ secret: res.secret, otpauth: res.otpauth });
      else toast('success', `This machine now follows ${res.url}`);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // A machine held by a chain cannot be re-pointed from here at all; one held by a code can, with
  // the code. An unlinked machine just needs the blob.
  const canPaste = !seal.sealed || seal.mode === 'totp';

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 className="grow">Remote Link</h3>
        <span className={remote?.configured ? 'badge badge-accent' : 'badge'}>{remote?.configured ? `following (${seal.mode === 'chain' ? 'chain' : 'chain + code'})` : 'not linked'}</span>
      </div>
      <p className="muted small">
        {remote?.configured
          ? `This machine follows a policy chain published by its administrator. ${seal.mode === 'chain' ? 'Only a signed link can change or release it — there is no code on this machine.' : 'Signed links deliver updates; the authenticator code is what changes the policy here.'}`
          : 'A Remote Link points this machine at a policy chain and pins the key that signs it. Paste one you were given, or publish your own below.'}
      </p>
      {remote?.linkedAt ? <p className="field-hint">Linked {formatDateTime(remote.linkedAt)}{remote.head ? ` — at link ${remote.seq} (${remote.head.slice(0, 12)}…)` : ''}.</p> : null}

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        {canPaste ? (
          <button type="button" className="btn btn-sm" onClick={() => setPasting(true)} disabled={disabled || busy}>
            {remote?.configured ? 'Replace link…' : 'Paste a link…'}
          </button>
        ) : (
          <p className="field-hint" style={{ margin: 0 }}>
            To point this machine somewhere else, publish a link on its current chain that unseals it first.
          </p>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPublishing(true)} disabled={disabled}>
          Publish a chain…
        </button>
      </div>

      {pasting ? (
        <Modal title={remote?.configured ? 'Replace the Remote Link' : 'Paste a Remote Link'} onClose={busy ? undefined : () => setPasting(false)}>
          <div className="stack">
            <p className="small">
              Paste the blob your administrator gave you. It carries the address of the policy chain and the key that signs it, and is signed with that key — so a blob mangled or
              swapped on the way here is refused rather than trusted.
            </p>
            {seal.sealed ? (
              <div className="callout callout-warning small">
                This machine is already linked. Replacing the link hands it to a different key, so the code from your authenticator app is asked for next.
              </div>
            ) : (
              <div className="callout callout-warning small">
                Pasting this seals the machine: from then on the policy is the chain's to set, and how you get back in depends on the mode the link names.
              </div>
            )}
            <label className="field">
              <span className="field-label">Remote Link</span>
              <textarea className="code" rows={5} spellCheck={false} value={blob} disabled={busy} onChange={(e) => setBlob(e.target.value)} />
            </label>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => setPasting(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || blob.trim().length === 0} onClick={() => (seal.sealed ? setPendingCode(true) : void apply())}>
              {busy ? 'Applying…' : seal.sealed ? 'Continue…' : 'Apply link'}
            </button>
          </div>
        </Modal>
      ) : null}

      {pendingCode ? <CodeDialog title="Replace the Remote Link" what="re-point" busy={busy} onClose={() => setPendingCode(false)} onSubmit={(code) => void apply(code)} /> : null}

      {enrolment ? (
        <Modal title="Enrol your authenticator app" onClose={() => setEnrolment(null)}>
          <div className="stack">
            <p className="small">This link asked for a machine you can also unlock by hand, so it generated a code. Scan it now — it is not shown again.</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <QrCode value={enrolment.otpauth} size={220} label="Scan to enrol this machine's policy lock" />
            </div>
            <details className="small">
              <summary>Can’t scan it?</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <label className="field">
                  <span className="field-label">Secret — type this into your app by hand</span>
                  <input className="input mono" readOnly value={enrolment.secret} onFocus={(e) => e.currentTarget.select()} />
                </label>
                <label className="field">
                  <span className="field-label">Enrolment URI</span>
                  <input className="input mono" readOnly value={enrolment.otpauth} onFocus={(e) => e.currentTarget.select()} />
                </label>
              </div>
            </details>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={() => setEnrolment(null)}>
              I have saved it
            </button>
          </div>
        </Modal>
      ) : null}

      {publishing ? <PublishDialog onClose={() => setPublishing(false)} /> : null}
    </div>
  );
}

/** The publishing side: the key, the Remote Link to hand out, and a signed version per policy. */
function PublishDialog({ onClose }: { onClose(): void }) {
  const [author, setAuthor] = useState<ChainAuthorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [blob, setBlob] = useState<string | null>(null);
  const [chainJson, setChainJson] = useState<string | null>(null);
  const [policyText, setPolicyText] = useState('');
  const [importPem, setImportPem] = useState('');
  const [settings, setSettings] = useState({ url: '', keyId: '', managedBy: '', mode: 'chain' as 'chain' | 'totp', intervalMinutes: 60 });

  const load = useCallback(async () => {
    try {
      const status = await api().system.authorStatus();
      setAuthor(status);
      setSettings((s) => ({
        ...s,
        url: status.url ?? s.url,
        keyId: status.keyId ?? s.keyId,
        managedBy: status.managedBy ?? s.managedBy,
        mode: status.mode,
      }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      toast('success', what);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Publish a policy chain" onClose={busy ? undefined : onClose} className="policy-modal">
      <p className="field-hint" style={{ marginTop: 0 }}>
        A chain is how a fleet is managed: you sign each version of the policy, every link commits to the one before it, and a machine that follows the chain verifies the whole way
        from where it is to where you are. Nothing here changes <em>this</em> machine.
      </p>
      {author ? <p className="muted small">{authorLine(author)}</p> : null}

      <div className="stack" style={{ gap: 12, marginTop: 8 }}>
        <div className="field">
          <span className="field-label">Signing key</span>
          {author?.hasKey ? (
            <>
              <input className="input mono" readOnly value={author.publicKey ?? ''} onFocus={(e) => e.currentTarget.select()} aria-label="Public key" />
              <span className="field-hint">
                The public half, which is what machines pin. {author.keyring ? 'The private half is protected by this machine’s keyring.' : 'There is no keyring here, so the private half is a 0600 file.'} Kept in{' '}
                <code className="nowrap">{author.dir}</code>.
              </span>
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run('Key copied', async () => copy(await api().system.authorExportKey()))}>
                  Copy private key (back it up)
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run('Key and chain forgotten', () => api().system.authorForget())}>
                  Forget it
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="field-hint">Generate one, or take over a key you already publish with.</span>
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run('Signing key generated', () => api().system.authorCreateKey())}>
                  Generate a key
                </button>
              </div>
              <textarea
                className="code"
                rows={3}
                spellCheck={false}
                placeholder="-----BEGIN PRIVATE KEY-----"
                aria-label="Private key to import"
                value={importPem}
                onChange={(e) => setImportPem(e.target.value)}
                style={{ marginTop: 6 }}
              />
              <div>
                <button type="button" className="btn btn-sm" disabled={busy || importPem.trim().length === 0} onClick={() => void run('Key imported', () => api().system.authorImportKey(importPem))}>
                  Import that key
                </button>
              </div>
            </>
          )}
        </div>

        <hr className="rule" />

        <div className="field">
          <label htmlFor="author-url">Where the chain will be published</label>
          <input id="author-url" type="text" placeholder="https://policies.example.com/chain.json" value={settings.url} disabled={busy} onChange={(e) => setSettings({ ...settings, url: e.target.value })} />
          <span className="field-hint">Machines fetch this address on the interval below. Serve the file this dialog exports.</span>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="author-keyid">Key name (optional)</label>
            <input id="author-keyid" type="text" placeholder="acme-2026" value={settings.keyId} disabled={busy} onChange={(e) => setSettings({ ...settings, keyId: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="author-interval">Check every</label>
            <div className="row" style={{ gap: 6 }}>
              <input id="author-interval" type="number" min={5} max={1440} style={{ width: 90 }} value={settings.intervalMinutes} disabled={busy} onChange={(e) => setSettings({ ...settings, intervalMinutes: Number(e.target.value) })} />
              <span className="muted small">minutes</span>
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="author-managedby">Managed by</label>
          <input id="author-managedby" type="text" placeholder="Acme IT" value={settings.managedBy} disabled={busy} onChange={(e) => setSettings({ ...settings, managedBy: e.target.value })} />
        </div>
        <div className="field">
          <span className="field-label">How machines that take this link are held</span>
          <label className="row small" style={{ gap: 6 }}>
            <input type="radio" name="author-mode" checked={settings.mode === 'chain'} disabled={busy} onChange={() => setSettings({ ...settings, mode: 'chain' })} />
            <span>
              <strong>Chain only</strong> — no code exists on the machine. Only a signed link can change the policy, and letting a machine go is a link with <code>unseal</code>.
            </span>
          </label>
          <label className="row small" style={{ gap: 6 }}>
            <input type="radio" name="author-mode" checked={settings.mode === 'totp'} disabled={busy} onChange={() => setSettings({ ...settings, mode: 'totp' })} />
            <span>
              <strong>Chain and a code</strong> — links still deliver updates, and whoever is at the machine can also unlock it with an authenticator code shown once when the link is
              pasted.
            </span>
          </label>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run('Saved', () => api().system.authorConfigure(settings))}>
            Save these
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !author?.hasKey}
            onClick={() =>
              void run('Remote Link ready', async () => {
                await api().system.authorConfigure(settings);
                setBlob((await api().system.authorRemoteLink()).blob);
              })
            }
          >
            Make the Remote Link
          </button>
        </div>
        {blob ? (
          <label className="field">
            <span className="field-label">Remote Link — hand this to each machine</span>
            <textarea className="code" rows={4} readOnly value={blob} onFocus={(e) => e.currentTarget.select()} />
            <div>
              <button type="button" className="btn btn-sm" onClick={() => void copy(blob)}>
                Copy
              </button>
            </div>
          </label>
        ) : null}

        <hr className="rule" />

        <div className="field">
          <span className="field-label">Sign a version</span>
          <span className="field-hint">
            Paste the policy JSON — the <em>Review</em> tab of the policy form produces exactly this — and it becomes the next link, hash-linked to the last one you signed.
          </span>
          <CodeEditor language="json" path="policy-sign" value={policyText} onChange={setPolicyText} readOnly={busy} height={150} ariaLabel="Policy JSON to sign" />
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !author?.hasKey || policyText.trim().length === 0}
              onClick={() =>
                void run('Version signed', async () => {
                  const policy = JSON.parse(policyText) as PolicyFile;
                  await api().system.authorAppendLink({ policy });
                  setPolicyText('');
                })
              }
            >
              Sign it as the next version
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !author?.hasKey}
              onClick={() => void run('Release signed', () => api().system.authorAppendLink({ unseal: true }))}
              title="Publishes a link that lifts the seal on every machine following this chain"
            >
              Sign a release
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy || (author?.links ?? 0) === 0} onClick={() => void run('Last version dropped', () => api().system.authorDropLastLink())}>
              Undo the last one
            </button>
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run('Chain ready', async () => setChainJson(prettyJson(await api().system.authorChain())))}>
            Show the chain file
          </button>
          {chainJson ? (
            <button type="button" className="btn btn-sm" onClick={() => void copy(chainJson)}>
              Copy it
            </button>
          ) : null}
        </div>
        {chainJson ? <pre className="code policy-json">{chainJson}</pre> : null}
      </div>

      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
    </Modal>
  );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('success', 'Copied');
  } catch {
    toast('error', 'Could not copy');
  }
}
