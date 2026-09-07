/** "3 images · 1 video · 1 audio" from an asset kind → count map. */
const LABELS: Record<string, [string, string]> = {
  image: ['image', 'images'],
  video: ['video', 'videos'],
  audio: ['audio', 'audio'],
  text: ['text file', 'text files'],
  other: ['other file', 'other files'],
};
const ORDER = ['image', 'video', 'audio', 'text', 'other'];

export function describeAssetCounts(counts: Record<string, number> | undefined): string {
  if (!counts) return '';
  const keys = Object.keys(counts).sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib) || a.localeCompare(b);
  });
  return keys
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => {
      const n = counts[k]!;
      const [one, many] = LABELS[k] ?? [k, k];
      return `${n} ${n === 1 ? one : many}`;
    })
    .join(' · ');
}
