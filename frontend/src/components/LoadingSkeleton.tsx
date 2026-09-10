interface SkeletonCardProps {
  /** Number of list rows to render as placeholders. */
  count?: number;
  /** Compact variant used for the detail-page calendar area. */
  dense?: boolean;
}

function Bone({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-line ${className}`} aria-hidden="true" />;
}

/**
 * Loading skeleton for the habit list (SPEC §9 "at least one loading
 * skeleton"). Renders a quiet stack of placeholder cards while data fetches.
 */
export function LoadingSkeleton({ count = 3, dense = false }: SkeletonCardProps) {
  if (dense) {
    return (
      <div className="card space-y-4 p-6" role="status" aria-label="Loading">
        <Bone className="h-8 w-2/3" />
        <Bone className="h-40 w-full" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  return (
    <div className="space-y-3" role="status" aria-label="Loading habits">
      {Array.from({ length: count }).map((_v, index) => (
        <div key={index} className="card space-y-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Bone className="h-5 w-40" />
              <Bone className="h-4 w-56" />
            </div>
            <Bone className="h-6 w-16" />
          </div>
          <div className="flex items-center gap-4">
            <Bone className="h-8 w-14" />
            <Bone className="h-8 w-14" />
            <Bone className="h-8 w-14" />
            <div className="ml-auto">
              <Bone className="h-9 w-32" />
            </div>
          </div>
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
