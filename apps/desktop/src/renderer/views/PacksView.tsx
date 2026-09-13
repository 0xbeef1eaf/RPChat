import { useState } from 'react';
import type { PackInspection } from '@rp/shared';
import { EmptyState } from '../components/common/EmptyState';
import { ConfirmDialog } from '../components/common/Modal';
import { InspectModal } from '../components/packs/InspectModal';
import { PackCard } from '../components/packs/PackCard';
import { installPackFromPath, pickAndInspectPack, uninstallPack } from '../store/actions';
import { useAppState } from '../store/store';

export function PacksView() {
  const packs = useAppState((s) => s.packs);
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [pending, setPending] = useState<{ sourcePath: string; inspection: PackInspection } | null>(null);

  const target = packs.find((p) => p.packId === pendingUninstall);

  const install = async (kind: 'file' | 'directory') => {
    setInstalling(true);
    const picked = await pickAndInspectPack(kind);
    setInstalling(false);
    if (picked) setPending(picked);
  };

  const confirmInstall = async () => {
    if (!pending) return;
    if (await installPackFromPath(pending.sourcePath)) setPending(null);
  };

  const installButtons = (
    <>
      <button type="button" className="btn btn-primary" disabled={installing} onClick={() => install('file')}>
        Install .rppack…
      </button>
      <button type="button" className="btn" disabled={installing} onClick={() => install('directory')}>
        Install from folder…
      </button>
    </>
  );

  return (
    <div className="view">
      <div className="view-header">
        <h1>Packs</h1>
        <div className="row">{installButtons}</div>
      </div>
      {packs.length === 0 ? (
        <EmptyState title="No packs installed" actions={installButtons}>
          A pack bundles a character with its persona, media and optional behaviour scripts. Install a <code>.rppack</code>{' '}
          file or point at an unpacked pack folder (one that contains <code>pack.json</code>). What characters may do on this PC is set
          once for all of them under Settings → Permissions.
        </EmptyState>
      ) : (
        <div className="pack-grid">
          {packs.map((p) => (
            <PackCard key={p.packId} pack={p} onUninstall={() => setPendingUninstall(p.packId)} />
          ))}
        </div>
      )}
      {pending ? (
        <InspectModal
          sourcePath={pending.sourcePath}
          inspection={pending.inspection}
          onConfirm={confirmInstall}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {target ? (
        <ConfirmDialog
          title={`Uninstall ${target.manifest.name}?`}
          message="The pack files are removed. Sessions with its characters stay but can no longer be continued. Permissions are app-wide (Settings → Permissions) and are not affected."
          confirmLabel="Uninstall"
          danger
          onCancel={() => setPendingUninstall(null)}
          onConfirm={() => {
            setPendingUninstall(null);
            void uninstallPack(target.packId);
          }}
        />
      ) : null}
    </div>
  );
}
