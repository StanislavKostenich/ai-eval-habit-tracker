import { useState } from 'react';

interface AvatarProps {
  name: string;
  src: string | null;
  size?: number;
}

/**
 * User avatar: the image when available, otherwise a monogram initial. A
 * broken image falls back to the monogram.
 */
export function Avatar({ name, src, size = 32 }: AvatarProps) {
  const [errored, setErrored] = useState(false);
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };

  if (src && !errored) {
    return (
      <img
        src={src}
        alt={name}
        style={style}
        onError={() => setErrored(true)}
        className="shrink-0 rounded-full object-cover ring-1 ring-line"
      />
    );
  }

  return (
    <span
      style={style}
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-evergreen font-display font-semibold text-white"
    >
      {initial}
    </span>
  );
}
