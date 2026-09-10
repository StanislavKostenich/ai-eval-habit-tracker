import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { authKeys } from '../hooks/useAuth';
import { Spinner } from '../components/Spinner';

const ERROR_MESSAGES: Record<string, string> = {
  google_auth_failed: 'Google sign-in failed. Check that the OAuth client is configured, or try Demo Login.',
  github_auth_failed: 'GitHub sign-in failed. Check that the OAuth client is configured, or try Demo Login.',
};

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const errorParam = searchParams.get('error');
  const errorMessage = errorParam ? ERROR_MESSAGES[errorParam] : null;
  const [demoError, setDemoError] = useState<string | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);

  // Clear the error param from the URL once it has been shown.
  useEffect(() => {
    if (errorParam && searchParams.toString() !== '') {
      searchParams.delete('error');
      setSearchParams(searchParams, { replace: true });
    }
  }, [errorParam, searchParams, setSearchParams]);

  const handleDemoLogin = async () => {
    setDemoLoading(true);
    setDemoError(null);
    try {
      await api.demoLogin();
      await queryClient.invalidateQueries({ queryKey: authKeys.me() });
      navigate('/', { replace: true });
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : 'Demo login failed. Try again.');
      setDemoLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-3 text-4xl" aria-hidden="true">
            🔥
          </div>
          <h1 className="font-display text-2xl font-semibold text-ink">Habit Tracker</h1>
          <p className="mt-1 text-sm text-ink-soft">Build streaks. Keep them alive.</p>
        </div>

        {errorMessage && (
          <div
            className="mb-4 rounded-lg border border-danger-ring bg-danger-soft px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {errorMessage}
          </div>
        )}

        <div className="card space-y-3 p-5">
          <a
            href="/api/auth/google"
            className="btn-secondary w-full justify-center"
          >
            <GoogleGlyph />
            Continue with Google
          </a>
          <a href="/api/auth/github" className="btn-secondary w-full justify-center">
            <GitHubGlyph />
            Continue with GitHub
          </a>

          <div className="flex items-center gap-3 py-1" aria-hidden="true">
            <div className="h-px flex-1 bg-line" />
            <span className="text-xs text-ink-faint">or</span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <button
            type="button"
            className="btn-primary w-full justify-center"
            onClick={handleDemoLogin}
            disabled={demoLoading}
          >
            {demoLoading && <Spinner className="h-4 w-4" />}
            {demoLoading ? 'Signing in…' : 'Demo Login'}
          </button>

          {demoError && (
            <p className="text-center text-xs text-danger" role="alert">
              {demoError}
            </p>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          SSO sessions persist for 24 hours.
        </p>
      </div>
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

function GitHubGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.2 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.57 22.29 24 17.79 24 12.5 24 5.87 18.63.5 12 .5z" />
    </svg>
  );
}
