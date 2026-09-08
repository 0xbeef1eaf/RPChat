import { isManaged } from '../../lib/managed';
import { useAppState } from '../../store/store';

/** Whether a dotted settings path is forced by the system policy. */
export function useManaged(path: string): boolean {
  const managed = useAppState((s) => s.managed);
  return isManaged(managed, path);
}

export function ManagedBadge({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span className="badge badge-warning" style={{ marginLeft: 6 }} title="Forced by the system policy file; cannot be changed here">
      managed by policy
    </span>
  );
}
