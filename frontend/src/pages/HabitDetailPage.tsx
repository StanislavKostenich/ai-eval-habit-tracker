import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getTodayISO } from '../lib/getTodayISO';
import { useHabit, useUpdateHabit } from '../hooks/useHabits';
import { useCheckins } from '../hooks/useCheckin';
import type { Habit, HabitStatus, UpdateHabitInput } from '../types';
import { Calendar } from '../components/Calendar';
import { HabitModal } from '../components/HabitModal';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { StatusBadge } from '../components/StatusBadge';

/** Shift a `YYYY-MM` value by `delta` months. */
function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const total = (year ?? 0) * 12 + ((m ?? 1) - 1) + delta;
  const y = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${y}-${String(mm).padStart(2, '0')}`;
}

export function HabitDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const habitQuery = useHabit(id);
  const updateHabit = useUpdateHabit();

  const today = getTodayISO();
  const currentMonth = today.slice(0, 7);
  const [month, setMonth] = useState(currentMonth);

  const checkinsQuery = useCheckins(id, month);
  const checkedDates = useMemo(
    () => new Set((checkinsQuery.data ?? []).map((checkin) => checkin.date)),
    [checkinsQuery.data],
  );

  const [modalOpen, setModalOpen] = useState(false);
  const habit = habitQuery.data;

  const handleEditSubmit = async (values: {
    name: string;
    description: string;
    startDate: string;
    status: HabitStatus;
  }) => {
    if (!habit) return;
    const input: UpdateHabitInput = { name: values.name };
    if (values.description) input.description = values.description;
    else input.description = null;
    if (values.status !== habit.status) input.status = values.status;
    await updateHabit.mutateAsync({ id: habit.id, input });
  };

  if (habitQuery.isError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <div className="card flex flex-col items-center gap-3 p-8 text-center" role="alert">
          <p className="font-medium text-danger">Habit not found.</p>
          <p className="text-sm text-ink-soft">
            It may have been deleted, or you don’t have access to it.
          </p>
          <Link to="/" className="btn-secondary mt-1">
            Back to habits
          </Link>
        </div>
      </div>
    );
  }

  if (habitQuery.isPending || !habit) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-10 sm:px-6">
        <LoadingSkeleton dense />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link to="/" className="btn-ghost -ml-2 px-2 py-1.5">
            ← Back
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="truncate font-display text-lg font-semibold text-ink">
              {habit.name}
            </h1>
            <StatusBadge status={habit.status} />
          </div>
          <button type="button" className="btn-secondary" onClick={() => setModalOpen(true)}>
            Edit
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        {habit.description && (
          <p className="max-w-prose text-sm text-ink-soft">{habit.description}</p>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Current streak" value={habit.currentStreak} accent />
          <StatCard label="Best streak" value={habit.bestStreak} />
          <StatCard label="Total check-ins" value={habit.totalCheckins} />
        </div>

        {/* Month navigation + calendar */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-ink">Calendar</h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn-ghost px-2.5 py-1.5"
                onClick={() => setMonth((m) => shiftMonth(m, -1))}
                aria-label="Previous month"
              >
                ‹
              </button>
              <button
                type="button"
                className="btn-ghost px-2.5 py-1.5"
                onClick={() => setMonth(currentMonth)}
              >
                This month
              </button>
              <button
                type="button"
                className="btn-ghost px-2.5 py-1.5"
                onClick={() => setMonth((m) => shiftMonth(m, 1))}
                aria-label="Next month"
              >
                ›
              </button>
            </div>
          </div>

          {checkinsQuery.isPending ? (
            <LoadingSkeleton dense />
          ) : (
            <Calendar month={month} checkedDates={checkedDates} today={today} />
          )}
        </section>
      </main>

      <HabitModal
        open={modalOpen}
        habit={habit}
        onClose={() => setModalOpen(false)}
        onSubmit={handleEditSubmit}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 text-center transition-colors ${
        accent
          ? 'border-fire/30 bg-fire-soft'
          : 'border-line bg-surface shadow-card'
      }`}
    >
      <div
        className={`font-display text-3xl font-bold ${
          accent ? 'text-fire' : 'text-ink'
        }`}
      >
        {value}
      </div>
      <div
        className={`mt-1 text-xs font-medium ${
          accent ? 'text-fire/80' : 'text-ink-soft'
        }`}
      >
        {label}
      </div>
    </div>
  );
}
