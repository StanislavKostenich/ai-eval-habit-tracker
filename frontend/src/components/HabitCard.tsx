import { Link } from 'react-router-dom';
import type { Habit } from '../types';
import { StatusBadge } from './StatusBadge';
import { Spinner } from './Spinner';

interface HabitCardProps {
  habit: Habit;
  onEdit: (habit: Habit) => void;
  onDelete: (habit: Habit) => void;
  onToggleCheckin: (habit: Habit) => void;
  /** Whether this habit's check-in toggle is currently in flight. */
  checkinBusy: boolean;
}

/** Left border color per status — quiet identity cue. */
const STATUS_BORDER: Record<Habit['status'], string> = {
  active: 'border-l-leaf',
  paused: 'border-l-amber',
  archived: 'border-l-stone',
};

/** One habit row on the dashboard (SPEC §9). */
export function HabitCard({ habit, onEdit, onDelete, onToggleCheckin, checkinBusy }: HabitCardProps) {
  const isArchived = habit.status === 'archived';
  const isPaused = habit.status === 'paused';
  const checkinDisabled = isArchived || isPaused;

  const toggleLabel = habit.completedToday ? 'Done Today ✓' : 'Check in Today';
  const toggleHint = checkinDisabled
    ? habit.status === 'archived'
      ? 'Archived habits cannot be checked in'
      : 'Paused habits cannot be checked in'
    : habit.completedToday
      ? 'Remove today’s check-in'
      : 'Record today’s check-in';

  return (
    <article
      className={`card border-l-4 p-5 transition-all duration-150 hover:scale-[1.005] hover:shadow-lift ${STATUS_BORDER[habit.status]}`}
    >
      {/* Top row: name + badge | edit/delete */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-semibold leading-tight text-ink">
              {habit.name}
            </h3>
            <StatusBadge status={habit.status} />
          </div>
          {habit.description ? (
            <p className="mt-1 max-w-prose text-sm text-ink-soft">{habit.description}</p>
          ) : (
            <p className="mt-1 text-sm text-ink-faint">No description</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn-ghost px-2.5 py-1.5"
            onClick={() => onEdit(habit)}
            aria-label={`Edit ${habit.name}`}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn-danger-ghost px-2.5 py-1.5"
            onClick={() => onDelete(habit)}
            aria-label={`Delete ${habit.name}`}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Bottom row: stats + calendar + check-in */}
      <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Stats */}
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {/* Current streak — the hero metric */}
          <div className="flex items-center gap-2">
            <dt className="sr-only">Current streak</dt>
            <dd className="inline-flex items-center gap-1.5 rounded-full bg-fire-soft px-3 py-1">
              <span className="font-display text-xl font-bold text-fire">{habit.currentStreak}</span>
              <span aria-hidden="true" className="text-base leading-none">🔥</span>
            </dd>
            <span className="text-sm text-ink-soft">
              day{habit.currentStreak === 1 ? '' : 's'}
            </span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Best streak</dt>
            <dd className="font-display text-xl font-semibold text-ink">{habit.bestStreak}</dd>
            <span className="text-sm text-ink-faint">⭐ best</span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">Total check-ins</dt>
            <dd className="font-display text-xl font-semibold text-ink-soft">{habit.totalCheckins}</dd>
            <span className="text-sm text-ink-faint">total</span>
          </div>
        </dl>

        {/* Actions */}
        <div className="flex items-center gap-2 sm:shrink-0">
          <Link
            to={`/habits/${habit.id}`}
            className="btn-ghost px-3 py-2 text-ink-soft hover:text-ink"
          >
            Calendar
          </Link>
          <button
            type="button"
            onClick={() => onToggleCheckin(habit)}
            disabled={checkinDisabled || checkinBusy}
            title={toggleHint}
            className={
              habit.completedToday
                ? 'btn-secondary min-w-36 text-leaf font-semibold hover:bg-leaf-soft'
                : 'btn-primary min-w-36 font-semibold'
            }
          >
            {checkinBusy && <Spinner className="h-4 w-4" />}
            {toggleLabel}
          </button>
        </div>
      </div>
    </article>
  );
}
