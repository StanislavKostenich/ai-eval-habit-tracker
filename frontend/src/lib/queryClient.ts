import { QueryClient } from '@tanstack/query-core';

/**
 * The single shared QueryClient instance for the app (SPEC §9).
 *
 * Conservative defaults: data stays fresh (staleTime 0) so edits made on one
 * page (e.g. the habit detail page) are reflected after invalidation, and
 * retries are off so API errors surface immediately to the UI instead of
 * silently retrying three times.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
