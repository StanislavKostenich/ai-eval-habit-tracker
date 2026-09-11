import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { getTodayISO } from '../lib/getTodayISO';
import { habitKeys } from './useHabits';

/** Canonical check-ins query key: `['checkins', habitId, month]`. */
export const checkinKeys = {
  month: (habitId: string, month: string) => ['checkins', habitId, month] as const,
};

/** Check-ins for a habit in a given month (`YYYY-MM`), ascending. */
export function useCheckins(habitId: string, month: string) {
  return useQuery({
    queryKey: checkinKeys.month(habitId, month),
    queryFn: () => api.listCheckins(habitId, month),
    enabled: habitId.length > 0 && month.length > 0,
  });
}

/**
 * The today check-in toggle (SPEC §9 HabitCard).
 *
 * `completedToday` decides the direction: true → undo today's check-in
 * (`DELETE` for `getTodayISO()`); false → check in (`POST` for
 * `getTodayISO()`). Both invalidate the habits-list prefix AND the toggled
 * habit's detail key, so streaks/`completedToday` refresh on the dashboard AND
 * a check-in/undo made while a detail page is open stays consistent. Use
 * `isHabitBusy(id)` to show a per-card spinner.
 */
export function useToggleCheckin() {
  const queryClient = useQueryClient();
  const mutation = useMutation<void, Error, { id: string; completedToday: boolean }>({
    mutationFn: async ({ id, completedToday }) => {
      const today = getTodayISO();
      if (completedToday) {
        await api.deleteCheckin(id, today);
      } else {
        await api.createCheckin(id, today);
      }
    },
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: habitKeys.all() });
      void queryClient.invalidateQueries({ queryKey: habitKeys.detail(id) });
    },
  });

  const isHabitBusy = (habitId: string): boolean =>
    mutation.isPending && mutation.variables?.id === habitId;

  return { toggle: mutation, isHabitBusy };
}
