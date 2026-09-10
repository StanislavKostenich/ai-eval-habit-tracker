import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type HabitsQuery } from '../lib/api';
import type { CreateHabitInput, Habit, UpdateHabitInput } from '../types';

/** Canonical habits query keys (SPEC §9 — one shape per resource). */
export const habitKeys = {
  all: () => ['habits'] as const,
  /** List key: `['habits', { status, q, completedToday }]`. */
  list: (filters: HabitsQuery) =>
    ['habits', { status: filters.status ?? '', q: filters.q ?? '', completedToday: filters.completedToday }] as const,
  /** Single habit key: `['habits', habitId]`. */
  detail: (id: string) => ['habits', id] as const,
};

/**
 * The shared habit-list query. Every screen that shows the list uses this hook
 * with the same key shape — search, status, and completed-today filters drive
 * the single key (SPEC §9 DashboardPage).
 */
export function useHabits(filters: HabitsQuery) {
  return useQuery({
    queryKey: habitKeys.list(filters),
    queryFn: () => api.listHabits(filters),
  });
}

export function useHabit(id: string) {
  return useQuery({
    queryKey: habitKeys.detail(id),
    queryFn: () => api.getHabit(id),
    enabled: id.length > 0,
  });
}

/** Create a habit; invalidates the list prefix so the dashboard refreshes. */
export function useCreateHabit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateHabitInput) => api.createHabit(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: habitKeys.all() });
    },
  });
}

/**
 * Update a habit. Invalidates BOTH the single-habit key and the habits-list
 * prefix so an edit made on the detail page doesn't leave the dashboard stale
 * (SPEC §9 HabitDetailPage).
 */
export function useUpdateHabit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateHabitInput }) =>
      api.updateHabit(id, input),
    onSuccess: (_habit, variables) => {
      void queryClient.invalidateQueries({ queryKey: habitKeys.detail(variables.id) });
      void queryClient.invalidateQueries({ queryKey: habitKeys.all() });
    },
  });
}

/** Delete a habit; invalidates the list prefix. */
export function useDeleteHabit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteHabit(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: habitKeys.all() });
    },
  });
}
