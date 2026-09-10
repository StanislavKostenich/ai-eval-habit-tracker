import { and, eq } from 'drizzle-orm';
import passport from 'passport';
// The shared passport instance is a singleton for the whole process; every
// import gets the same instance (passport's CommonJS module cache).
import { Strategy as GoogleStrategy, type Profile as GoogleProfile } from 'passport-google-oauth20';
import { Strategy as GithubStrategy, type Profile as GithubProfile } from 'passport-github2';
import type { AppDatabase } from '../db/index.js';
import { users } from '../db/schema.js';

/** Minimal logger surface used for non-fatal warnings. */
export type AuthLogger = { warn: (msg: string) => void };

/**
 * The subset of the passport profile shape the app consumes, kept structural
 * (rather than importing the strategy's `Profile` type) so it stays usable
 * with either the google or github strategy.
 */
export interface SsoProfile {
  id: string;
  displayName?: string | undefined;
  username?: string | undefined;
  emails?: Array<{ value?: string }> | undefined;
  photos?: Array<{ value?: string }> | undefined;
}

/**
 * Fetches the user's primary (or first) email from GitHub when the OAuth
 * profile does not expose a public email (docs/SPEC.md §5: GitHub's profile
 * may not expose a public email — fall back to `GET /user/emails` using the
 * access token from the token exchange and pick the `primary` address).
 */
async function fetchGithubEmail(accessToken: string, log: AuthLogger): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'habit-tracker',
      },
    });
    if (!res.ok) {
      log.warn(`GitHub /user/emails fallback failed with status ${res.status}`);
      return null;
    }
    const data = (await res.json()) as Array<{ email: string; primary?: boolean }>;
    const primary = data.find((entry) => entry.primary && entry.email);
    const first = data.find((entry) => entry.email);
    return (primary ?? first)?.email ?? null;
  } catch (err) {
    log.warn(`GitHub /user/emails fallback failed: ${String(err)}`);
    return null;
  }
}

/**
 * Find-or-create the user row for an SSO sign-in (docs/SPEC.md §5: "on first
 * sign-in via any provider, auto-create a `users` row"). The existing row is
 * refreshed with the freshest profile data on each sign-in.
 *
 * Uses `and(eq(...), eq(...))` for the two-part lookup per CLAUDE.md hard rule 2.
 */
export async function findOrCreateUser(
  db: AppDatabase,
  provider: 'google' | 'github',
  providerUserId: string,
  profile: SsoProfile,
  email: string | null,
): Promise<{ id: string }> {
  const displayName = profile.displayName ?? profile.username ?? providerUserId;
  const avatarUrl = profile.photos?.[0]?.value ?? null;
  const nowSec = Math.floor(Date.now() / 1000);

  const existing = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.provider, provider), eq(users.providerUserId, providerUserId)))
    .get();

  if (existing) {
    db.update(users)
      .set({ displayName, email, avatarUrl })
      .where(and(eq(users.provider, provider), eq(users.providerUserId, providerUserId)))
      .run();
    return { id: existing.id };
  }

  const inserted = db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      provider,
      providerUserId,
      email,
      displayName,
      avatarUrl,
      createdAt: nowSec,
    })
    .returning({ id: users.id })
    .get();
  return { id: inserted.id };
}

/**
 * Configures the shared passport instance for this process:
 * - Google (`passport-google-oauth20`) and GitHub (`passport-github2`)
 *   strategies, actually invoked by the route handlers via
 *   `passport.authenticate(...)` (docs/SPEC.md §5 Option A);
 * - `serializeUser`/`deserializeUser` round-trip ONLY the user id — the
 *   session must hold just `userId` (docs/SPEC.md §5).
 *
 * Strategies are registered only when their client IDs are configured.
 * Without a real clientID, `OAuth2Strategy`'s constructor throws
 * (`OAuth2Strategy requires a clientID option`), which would prevent the app
 * from booting for local dev, tests, or Docker when OAuth env vars are absent.
 * The auth routes detect the unregistered case and redirect to the frontend
 * with `?error=<provider>_auth_failed` instead.
 */
export function registerPassport(db: AppDatabase, log: AuthLogger): void {
  const googleVerify = async (
    _req: unknown,
    _accessToken: string,
    _refreshToken: string,
    profile: GoogleProfile,
    done: (err: Error | null, user?: { id: string } | false) => void,
  ): Promise<void> => {
    try {
      const email = profile.emails?.[0]?.value ?? null;
      const user = await findOrCreateUser(db, 'google', profile.id, profile, email);
      done(null, user);
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const githubVerify = async (
    _req: unknown,
    accessToken: string,
    _refreshToken: string,
    profile: GithubProfile,
    done: (err: Error | null, user?: { id: string } | false) => void,
  ): Promise<void> => {
    try {
      // GitHub's OAuth profile may not expose a public email — fall back to
      // `GET /user/emails` with the access token and pick the primary address.
      const profileEmail = profile.emails?.[0]?.value ?? null;
      const email = profileEmail ?? (await fetchGithubEmail(accessToken, log));
      const user = await findOrCreateUser(db, 'github', profile.id, profile, email);
      done(null, user);
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // OAuth callback URLs are built from BACKEND_URL — never hardcoded
  // (docs/SPEC.md §3, CLAUDE.md hard rule 5).
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const githubClientId = process.env.GITHUB_CLIENT_ID;

  if (googleClientId && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: googleClientId,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${backendUrl}/api/auth/google/callback`,
          scope: ['openid', 'email', 'profile'],
        },
        // The shipped `@types/passport-google-oauth20` only accepts synchronous
        // verify shapes, but the strategy inspects the verify arity at
        // invocation time — passing the async verify directly is runtime-safe.
        // Hence the single `as never` cast (no `any` in app code).
        googleVerify as never,
      ),
    );
  } else {
    log.warn('GOOGLE_CLIENT_ID/SECRET not set — Google OAuth disabled (demo login unaffected)');
  }

  if (githubClientId && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(
      new GithubStrategy(
        {
          clientID: githubClientId,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          callbackURL: `${backendUrl}/api/auth/github/callback`,
        },
        githubVerify as never,
      ),
    );
  } else {
    log.warn('GITHUB_CLIENT_ID/SECRET not set — GitHub OAuth disabled (demo login unaffected)');
  }

  // Serialize/deserialize round-trip the user id only (docs/SPEC.md §5).
  passport.serializeUser((user: unknown, done: (err: Error | null, id?: string | false) => void) => {
    const id = (user as { id?: unknown })?.id;
    done(null, typeof id === 'string' ? id : false);
  });
  passport.deserializeUser((id: unknown, done: (err: Error | null, user?: { id: string } | null) => void) => {
    done(null, typeof id === 'string' ? { id } : null);
  });
}
