import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import passport from 'passport';
import type { AppDatabase } from '../db/index.js';
import { users, type UserRow } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Safe profile returned by `GET /api/auth/me` (docs/SPEC.md §5) — no
 * internal-only fields such as `providerUserId`.
 */
export interface SafeProfile {
  id: string;
  provider: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  createdAt: number;
}

function toSafeProfile(row: UserRow): SafeProfile {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
  };
}

/** Demo SSO identity for `POST /api/auth/demo-login` (docs/SPEC.md §5). */
const DEMO_PROVIDER = 'demo';
const DEMO_PROVIDER_USER_ID = 'demo-user';
const DEMO_DISPLAY_NAME = 'Demo User';

/**
 * Auth routes (docs/SPEC.md §5), mounted at `/api/auth`.
 *
 * Google/GitHub SSO is Option A from the spec: real Passport strategies
 * registered in `registerPassport()` and actually invoked here via
 * `passport.authenticate(...)`. The demo login is a first-class endpoint —
 * not env-gated — used by the automated test suite and local development.
 */
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = (app as unknown as { db: AppDatabase }).db;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  /**
   * POST /api/auth/demo-login — no body, no env gate. Find-or-create the demo
   * user, set the session (only `userId`), return `{ message, userId }`.
   */
  app.post('/demo-login', async (request: FastifyRequest, reply: FastifyReply) => {
    const existing = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.providerUserId, DEMO_PROVIDER_USER_ID))
      .get();

    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      const inserted = db
        .insert(users)
        .values({
          id: randomUUID(),
          provider: DEMO_PROVIDER,
          providerUserId: DEMO_PROVIDER_USER_ID,
          email: null,
          displayName: DEMO_DISPLAY_NAME,
          avatarUrl: null,
          createdAt: Math.floor(Date.now() / 1000),
        })
        .returning({ id: users.id })
        .get();
      userId = inserted.id;
    }

    // The session holds only `userId` (docs/SPEC.md §5). The session type
    // carries no `userId` field by default, so cast through `SessionLike`
    // (src/types.d.ts) — structurally typed, not module-augmented.
    (request.session as unknown as { userId?: string }).userId = userId;
    return reply.status(200).send({ message: 'Demo login successful', userId });
  });

  /**
   * Returns true if the named passport strategy is registered (i.e. its
   * OAuth client ID was configured at boot). Used by the provider routes to
   * decide whether to delegate to passport or redirect to the frontend
   * error page (docs/SPEC.md §5: failure redirect to `FRONTEND_URL/login?error=...`).
   */
  function isStrategyRegistered(name: string): boolean {
    // `passport` is the singleton `Authenticator` instance; its `_strategies`
    // map holds registered strategies by name.
    const auth = passport as unknown as { _strategies?: Record<string, unknown> };
    return auth._strategies?.[name] !== undefined;
  }

  /**
   * GET /api/auth/google — hand off to the registered Google strategy, which
   * redirects the browser to the OAuth consent screen (redirect_uri built
   * from BACKEND_URL inside the strategy, docs/SPEC.md §3/§5).
   * If the strategy is not registered (no GOOGLE_CLIENT_ID at boot), redirect
   * to the frontend error page.
   */
  app.get('/google', (request: FastifyRequest, reply: FastifyReply) => {
    if (!isStrategyRegistered('google')) {
      return reply.redirect(`${frontendUrl}/login?error=google_auth_failed`);
    }
    passport.authenticate('google', { scope: ['openid', 'email', 'profile'] })(
      request.raw,
      reply.raw,
      () => {
        // Only reached if the strategy did not redirect (e.g. a fatal error
        // inside the strategy); surface it instead of hanging the request.
        void reply.code(500).send({ error: 'Authentication error' });
      },
    );
  });

  /** GET /api/auth/github — redirect to the GitHub OAuth consent screen. */
  app.get('/github', (request: FastifyRequest, reply: FastifyReply) => {
    if (!isStrategyRegistered('github')) {
      return reply.redirect(`${frontendUrl}/login?error=github_auth_failed`);
    }
    passport.authenticate('github')(request.raw, reply.raw, () => {
      void reply.code(500).send({ error: 'Authentication error' });
    });
  });

  /** GET /api/auth/google/callback — exchange the code, upsert the user
   * (inside the strategy's verify), set the session via passport's logIn
   * (serializeUser round-trips only the id), then redirect to the app. */
  app.get('/google/callback', (request: FastifyRequest, reply: FastifyReply) => {
    if (!isStrategyRegistered('google')) {
      return reply.redirect(`${frontendUrl}/login?error=google_auth_failed`);
    }
    passport.authenticate('google', {
      failureRedirect: `${frontendUrl}/login?error=google_auth_failed`,
      successRedirect: `${frontendUrl}/`,
    })(request.raw, reply.raw, () => {
      void reply.code(500).send({ error: 'Authentication error' });
    });
  });

  /** GET /api/auth/github/callback — complete the OAuth exchange. */
  app.get('/github/callback', (request: FastifyRequest, reply: FastifyReply) => {
    if (!isStrategyRegistered('github')) {
      return reply.redirect(`${frontendUrl}/login?error=github_auth_failed`);
    }
    passport.authenticate('github', {
      failureRedirect: `${frontendUrl}/login?error=github_auth_failed`,
      successRedirect: `${frontendUrl}/`,
    })(request.raw, reply.raw, () => {
      void reply.code(500).send({ error: 'Authentication error' });
    });
  });

  /**
   * POST /api/auth/logout — await the session destroy BEFORE responding
   * (docs/SPEC.md §5: a fire-and-forget destroy can leave the client
   * authenticated momentarily).
   */
  app.post('/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.session.sessionId) {
      await request.session.destroy();
    }
    reply.clearCookie('sessionId');
    return reply.code(204).send();
  });

  /**
   * GET /api/auth/me — current user's safe profile, or 401 when not logged
   * in (docs/SPEC.md §5/§12).
   */
  app.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as { userId?: string }).userId;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const row = db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) {
      // Stale session pointing at a deleted user — treat as logged out.
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    return reply.status(200).send(toSafeProfile(row));
  });
}
