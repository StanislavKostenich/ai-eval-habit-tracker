import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { User } from '../types';

/** Canonical auth query key — the single shape every screen uses. */
export const authKeys = {
  me: () => ['auth', 'me'] as const,
};

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  logout: () => Promise<void>;
}

/**
 * Auth state for the whole app: the `['auth', 'me']` query plus a logout
 * action that clears the entire query cache and the auth key before
 * navigating to `/login` (SPEC §9 DashboardPage header).
 */
export function useAuth(): AuthState {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: authKeys.me(),
    queryFn: () => api.me(),
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onMutate: async () => {
      // Clear stale server state immediately so no page renders a logged-in
      // view for a moment after the session is destroyed.
      await queryClient.cancelQueries();
      queryClient.clear();
    },
    onSuccess: () => {
      queryClient.setQueryData(authKeys.me(), null);
    },
  });

  return {
    user: meQuery.data ?? null,
    isAuthenticated: meQuery.data !== undefined,
    isAuthLoading: meQuery.isPending,
    logout: () => logoutMutation.mutateAsync(),
  };
}
