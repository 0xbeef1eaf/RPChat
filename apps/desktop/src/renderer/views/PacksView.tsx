import { useMemo, useState } from 'react';
import type { PackInspection } from '@rp/shared';
import { EmptyState } from '../components/common/EmptyState';
import { ConfirmDialog } from '../components/common/Modal';
import { InspectModal } from '../components/packs/InspectModal';
import { PackCard } from '../components/packs/PackCard';
import { installPackFromPath, pickAndInspectPack, uninstallPack } from '../store/actions';
import { useAppState } from '../store/store';

export function PacksView() {
  const packs = useAppState((s) => s.packs);
  const caps = useAppState((s) => s.capabilities);
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [pending, setPending] = useState<{ sourcePath: string; inspection: PackInspection } | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  const capMap = useMemo(() => new Map(caps.map((c) => [c.id, c])), [caps]);
  const target = packs.find((p) => p.packId === pendingUninstall);

  // Filter chips: every module any installed pack requests.
  const requestedModules = useMemo(() => Array.from(new Set(packs.flatMap((p) => p.requestedCapabilities))).sort(), [packs]);
  const visiblePacks = useMemo(() => (filter ? packs.filter((p) => p.requestedCapabilities.includes(filter)) : packs), [packs, filter]);

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
          A pack bundles one or more characters with their persona, media and optional behaviour scripts. Install a <code>.rppack</code>{' '}
          file or point at an unpacked pack folder (one that contains <code>pack.json</code>).
        </EmptyState>
      ) : (
        <>
          {requestedModules.length > 0 ? (
            <div className="chips" style={{ marginBottom: 14 }} role="group" aria-label="Filter by capability">
              <button type="button" className={filter === null ? 'chip-btn on' : 'chip-btn'} onClick={() => setFilter(null)}>
                All ({packs.length})
              </button>
              {requestedModules.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={filter === m ? 'chip-btn on' : 'chip-btn'}
                  title={capMap.get(m)?.summary}
                  aria-pressed={filter === m}
                  onClick={() => setFilter(filter === m ? null : m)}
                >
                  {capMap.get(m)?.title ?? m} ({packs.filter((p) => p.requestedCapabilities.includes(m)).length})
                </button>
              ))}
            </div>
          ) : null}
          <div className="pack-grid">
            {visiblePacks.map((p) => (
              <PackCard key={p.packId} pack={p} capabilities={capMap} onUninstall={() => setPendingUninstall(p.packId)} />
            ))}
            {visiblePacks.length === 0 ? <p className="muted">No installed pack requests {filter}.</p> : null}
          </div>
        </>
      )}
      {pending ? (
        <InspectModal
          sourcePath={pending.sourcePath}
          inspection={pending.inspection}
          capabilities={capMap}
          onConfirm={confirmInstall}
          onCancel={() => setPending(null)}
        />
      ) : null}
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
