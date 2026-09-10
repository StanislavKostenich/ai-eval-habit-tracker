import type { HabitStatus } from '../types';

interface StatusBadgeProps {
  status: HabitStatus;
}

/**
 * A semantic status badge (SPEC §9). Uses the three token families that map
 * directly to status meaning: leaf (active), amber (paused), stone (archived).
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  switch (status) {
    case 'active':
      return (
        <span className="badge bg-leaf-soft text-leaf">
          <span className="h-1.5 w-1.5 rounded-full bg-leaf" aria-hidden="true" />
          Active
        </span>
      );
    case 'paused':
      return (
        <span className="badge bg-amber-soft text-amber">
          <span className="h-1.5 w-1.5 rounded-full bg-amber" aria-hidden="true" />
          Paused
        </span>
      );
    case 'archived':
      return (
        <span className="badge bg-stone-soft text-stone">
          <span className="h-1.5 w-1.5 rounded-full bg-stone" aria-hidden="true" />
          Archived
        </span>
      );
  }
}
