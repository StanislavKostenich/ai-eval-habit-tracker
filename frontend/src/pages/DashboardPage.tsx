import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  useCreateHabit,
  useDeleteHabit,
  useHabits,
  useUpdateHabit,
} from '../hooks/useHabits';
import { useToggleCheckin } from '../hooks/useCheckin';
import type { HabitsQuery } from '../lib/api';
import type { CreateHabitInput, Habit, HabitStatus, UpdateHabitInput } from '../types';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { HabitCard } from '../components/HabitCard';
import { HabitModal } from '../components/HabitModal';
import { LoadingSkeleton } from '../components/LoadingSkeleton';

type StatusFilter = 'active' | 'paused' | 'archived' | '';
type CompletedFilter = 'all' | 'true' | 'false';

export function DashboardPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [completed, setCompleted] = useState<CompletedFilter>('all');

  const filters: HabitsQuery = {
    status: status || undefined,
    q: search,
    completedToday: completed === 'all' ? null : completed === 'true',
  };

  const habitsQuery = useHabits(filters);
  const createHabit = useCreateHabit();
  const updateHabit = useUpdateHabit();
  const deleteHabit = useDeleteHabit();
  const { toggle: toggleCheckin, isHabitBusy } = useToggleCheckin();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingHabit, setEditingHabit] = useState<Habit | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Habit | null>(null);

  const hasFilters = search.trim() !== '' || status !== '' || completed !== 'all';

  const openCreate = () => {
    setEditingHabit(null);
    setModalOpen(true);
  };
  const openEdit = (habit: Habit) => {
    setEditingHabit(habit);
    setModalOpen(true);
  };
  const closeModal = () => setModalOpen(false);

  const handleSubmit = async (values: {
    name: string;
    description: string;
    startDate: string;
    status: HabitStatus;
  }) => {
    if (editingHabit) {
      const input: UpdateHabitInput = { name: values.name };
      if (values.description) input.description = values.description;
      else input.description = null;
      if (values.status !== editingHabit.status) input.status = values.status;
      await updateHabit.mutateAsync({ id: editingHabit.id, input });
    } else {
      const input: CreateHabitInput = {
        name: values.name,
        startDate: values.startDate,
        status: values.status,
      };
      if (values.description) input.description = values.description;
      await createHabit.mutateAsync(input);
    }
  };

  const handleToggleCheckin = (habit: Habit) => {
    toggleCheckin.mutate({ id: habit.id, completedToday: habit.completedToday });
  };

  const handleDeleteConfirm = () => {
    if (!pendingDelete) return;
    deleteHabit.mutate(pendingDelete.id, {
      onSuccess: () => setPendingDelete(null),
    });
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const habits = habitsQuery.data ?? [];
  const isListLoading = habitsQuery.isPending;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl" aria-hidden="true">
              🔥
            </span>
            <h1 className="font-display text-lg font-semibold text-ink">Habit Tracker</h1>
          </div>
          {user && (
            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-2 sm:flex">
                <Avatar name={user.displayName} src={user.avatarUrl} size={30} />
                <span className="text-sm font-medium text-ink">{user.displayName}</span>
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={handleLogout}
                aria-label="Log out"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        {/* Toolbar */}
        <div className="mb-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <span
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
                aria-hidden="true"
              >
                🔍
              </span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search habits…"
                className="input pl-9"
                aria-label="Search habits"
              />
            </div>
            <button
              type="button"
              className="btn-primary shrink-0"
              onClick={openCreate}
            >
              + New habit
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
              className="input w-auto"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
            </select>
            <select
              value={completed}
              onChange={(event) => setCompleted(event.target.value as CompletedFilter)}
              className="input w-auto"
              aria-label="Filter by completed today"
            >
              <option value="all">Any completion</option>
              <option value="true">Completed today</option>
              <option value="false">Not completed today</option>
            </select>
          </div>
        </div>

        {/* List / empty states */}
        {habitsQuery.isError ? (
          <div className="card p-8 text-center" role="alert">
            <p className="text-sm font-medium text-danger">
              Couldn’t load your habits.
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {habitsQuery.error instanceof Error
                ? habitsQuery.error.message
                : 'Something went wrong.'}
            </p>
            <button
              type="button"
              className="btn-secondary mt-4"
              onClick={() => void habitsQuery.refetch()}
            >
              Try again
            </button>
          </div>
        ) : isListLoading ? (
          <LoadingSkeleton />
        ) : habits.length === 0 ? (
          <div className="card flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
            <div
              className={`flex h-16 w-16 items-center justify-center rounded-full text-3xl ${
                hasFilters ? 'bg-stone-soft' : 'bg-leaf-soft'
              }`}
              aria-hidden="true"
            >
              {hasFilters ? '🔎' : '🌱'}
            </div>
            {hasFilters ? (
              <>
                <h2 className="font-display text-lg font-semibold text-ink">
                  No habits match your filters
                </h2>
                <p className="max-w-sm text-sm text-ink-soft">
                  Try a different search, status, or completion filter.
                </p>
                <button
                  type="button"
                  className="btn-secondary mt-1"
                  onClick={() => {
                    setSearch('');
                    setStatus('');
                    setCompleted('all');
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <h2 className="font-display text-lg font-semibold text-ink">
                  No habits yet
                </h2>
                <p className="max-w-sm text-sm text-ink-soft">
                  Start your first streak. Create a habit and check in every day to keep it alive.
                </p>
                <button type="button" className="btn-primary mt-1" onClick={openCreate}>
                  Create your first habit
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {habits.map((habit) => (
              <HabitCard
                key={habit.id}
                habit={habit}
                onEdit={openEdit}
                onDelete={setPendingDelete}
                onToggleCheckin={handleToggleCheckin}
                checkinBusy={isHabitBusy(habit.id)}
              />
            ))}
          </div>
        )}
      </main>

      <HabitModal
        open={modalOpen}
        habit={editingHabit}
        onClose={closeModal}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete habit"
        message={
          pendingDelete
            ? `Delete “${pendingDelete.name}” and all of its check-ins? This can’t be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        busy={deleteHabit.isPending}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
