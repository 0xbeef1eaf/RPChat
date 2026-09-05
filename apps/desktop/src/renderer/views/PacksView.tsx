import { useEffect, useMemo, useState } from 'react';
import type { CapabilityInfo } from '@rp/shared';
import { api } from '../api';
import { EmptyState } from '../components/common/EmptyState';
import { ConfirmDialog } from '../components/common/Modal';
import { PackCard } from '../components/packs/PackCard';
import { installPack, uninstallPack } from '../store/actions';
import { useAppState } from '../store/store';

export function PacksView() {
  const packs = useAppState((s) => s.packs);
  const [caps, setCaps] = useState<CapabilityInfo[]>([]);
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    api()
      .capabilities.list()
      .then(setCaps)
      .catch((err) => console.error('capabilities.list failed', err));
  }, []);

  const capMap = useMemo(() => new Map(caps.map((c) => [c.id, c])), [caps]);
  const target = packs.find((p) => p.packId === pendingUninstall);

  const install = async (kind: 'file' | 'directory') => {
    setInstalling(true);
    await installPack(kind);
    setInstalling(false);
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
          A pack bundles one or more characters with their persona, media and optional behaviour scripts. Install a <code>.rppack</code>{' '}
          file or point at an unpacked pack folder (one that contains <code>pack.json</code>).
        </EmptyState>
      ) : (
        <div className="pack-grid">
          {packs.map((p) => (
            <PackCard key={p.packId} pack={p} capabilities={capMap} onUninstall={() => setPendingUninstall(p.packId)} />
          ))}
        </div>
      )}
      {target ? (
        <ConfirmDialog
          title={`Uninstall ${target.manifest.name}?`}
          message="The pack files and its capability grants are removed. Sessions with its characters stay but can no longer be continued."
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
