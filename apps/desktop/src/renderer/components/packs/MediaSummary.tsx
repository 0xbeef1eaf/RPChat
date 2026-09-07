import { useState } from 'react';
import type { TagSummary } from '@rp/shared';
import { describeAssetCounts } from '../../lib/assets';

interface MediaSummaryProps {
  assetCounts: Record<string, number> | undefined;
  assetTags: TagSummary[] | undefined;
}

const VISIBLE_TAGS = 12;

/** "Media" line for a pack: asset counts by kind plus tag chips. */
export function MediaSummary({ assetCounts, assetTags }: MediaSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const counts = describeAssetCounts(assetCounts);
  const tags = (assetTags ?? []).slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  if (!counts && tags.length === 0) return null;
  const shown = expanded ? tags : tags.slice(0, VISIBLE_TAGS);
  const hidden = tags.length - shown.length;

  return (
    <div className="media-summary">
      <span className="muted small">
        <strong>Media:</strong> {counts || 'no assets'}
      </span>
      {tags.length > 0 ? (
        <span className="chips" style={{ marginTop: 4 }}>
          {shown.map((t) => (
            <span key={t.tag} className="chip" title={t.description ?? `${t.count} asset${t.count === 1 ? '' : 's'} tagged ${t.tag}`}>
              {t.tag} <span className="chip-count">×{t.count}</span>
            </span>
          ))}
          {hidden > 0 ? (
            <button type="button" className="chip-btn" onClick={() => setExpanded(true)}>
              +{hidden} more
            </button>
          ) : expanded && tags.length > VISIBLE_TAGS ? (
            <button type="button" className="chip-btn" onClick={() => setExpanded(false)}>
              show fewer
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
