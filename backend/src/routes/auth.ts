import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDatabase } from '../db/index.js';
import { users, type UserRow } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildAuthorizeUrl, completeOAuth, isProviderConfigured, type AuthLogger } from '../auth/oauth.js';

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

type ProviderName = 'google' | 'github';

/** The session carries only `userId` (docs/SPEC.md §5); `oauthState` is a
 *  transient, single-use CSRF value that is cleared after the callback. */
interface SessionShape {
  userId?: string;
  oauthState?: string;
}

/**
 * Auth routes (docs/SPEC.md §5), mounted at `/api/auth`.
 *
 * Google/GitHub SSO is a **hand-rolled OAuth2 authorization-code flow**
 * (docs/SPEC.md §5: "Do not use Passport.js"). The provider-specific logic
 * lives in `src/auth/oauth.ts`; these routes only: (a) redirect to the
 * provider's consent screen, (b) complete the callback (verify state, exchange
 * the code, fetch userinfo, find-or-create the user) and set the session, and
 * (c) demo-login / logout / me.
 *
 * The demo login is a first-class endpoint in dev/test, but returns 404 in
 * production (`NODE_ENV === 'production'`) so it can never be used to
 * impersonate the demo user on a live deployment (docs/SPEC.md §5).
 */
export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = (app as unknown as { db: AppDatabase }).db;
  const log: AuthLogger = app.log;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  /** Redirect to the frontend error page (docs/SPEC.md §5). */
  function errorRedirect(name: ProviderName, reply: FastifyReply): FastifyReply {
    return reply.redirect(`${frontendUrl}/login?error=${name}_auth_failed`);
  }

  /**
   * POST /api/auth/demo-login — no body. In production this is not a route
   * at all: it 404s (indistinguishable from a missing endpoint, so its
   * existence can't be probed). In dev/test it find-or-creates the demo user,
   * sets the session (only `userId`), and returns `{ message, userId }`
   * (docs/SPEC.md §5).
   */
  app.post('/demo-login', async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.NODE_ENV === 'production') {
      return reply.status(404).send({ error: 'Not found' });
    }
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

    // The session holds only `userId` (docs/SPEC.md §5).
    (request.session as unknown as SessionShape).userId = userId;
    return reply.status(200).send({ message: 'Demo login successful', userId });
  });

  // --- Google / GitHub authorization kickoff -----------------------------
  for (const name of ['google', 'github'] as const) {
    app.get(`/${name}`, (request: FastifyRequest, reply: FastifyReply) => {
      if (!isProviderConfigured(name)) {
        return errorRedirect(name, reply);
      }
      const session = request.session as unknown as SessionShape;
      const url = buildAuthorizeUrl(name, session);
      if (!url) {
        // Configured check passed; a null here is a defensive guard.
        return errorRedirect(name, reply);
      }
      return reply.redirect(url);
    });

    // --- Callback: complete the OAuth exchange ----------------------------
    app.get(`/${name}/callback`, async (request: FastifyRequest, reply: FastifyReply) => {
      const session = request.session as unknown as SessionShape;
      const { code, state } = request.query as { code?: unknown; state?: unknown };
      try {
        const userId = await completeOAuth(name, session, code, state, db, log);
        session.userId = userId;
        return reply.redirect(`${frontendUrl}/`);
      } catch (err) {
        log.warn(`${name} OAuth callback failed: ${err instanceof Error ? err.message : String(err)}`);
        return errorRedirect(name, reply);
      }
    });
  }

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
    const userId = (request.session as unknown as SessionShape).userId;
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
