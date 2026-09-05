interface AvatarProps {
  name: string;
  url?: string;
  size?: 'md' | 'lg';
}

/** Avatar image from an `rp-asset://` URL, or the character's initial when there is none. */
export function Avatar({ name, url, size = 'md' }: AvatarProps) {
  const cls = size === 'lg' ? 'avatar avatar-lg' : 'avatar';
  if (url) return <img className={cls} src={url} alt="" draggable={false} />;
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span className={cls} aria-hidden="true">
      {initial}
    </span>
  );
}
