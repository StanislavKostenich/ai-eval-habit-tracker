import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import type { AppDatabase } from './db/index.js';
import { createSessionStore } from './session/sqliteStore.js';
import { createRateLimiter, registerRateLimit, type RateLimiter } from './middleware/rateLimit.js';
import authRoutes from './routes/auth.js';
import habitRoutes from './routes/habits.js';
import wsRoutes from './ws/handler.js';

/** 24 hours in seconds — session cookie lifetime (docs/SPEC.md §5). */
const SESSION_MAX_AGE_SEC = 24 * 60 * 60;

/**
 * SESSION_SECRET is required in **every** environment (docs/SPEC.md §3): boot
 * hard-fails when it is missing or shorter than 32 characters. There is no
 * development fallback — that would let a forgotten secret silently sign
 * session cookies with a known constant. Developers set it in `.env`; CI and
 * Docker provide it explicitly.
 */
function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET must be set to a random string of at least 32 characters (all environments — copy .env.example to .env)',
    );
  }
  return secret;
}

/**
 * Builds the Fastify instance with cookies + sessions registered.
 * `db` is carried on the instance (app.db) so route plugins can reach the
 * database without re-opening it.
 *
 * Auth: `createApp` requires a database — the auth routes (docs/SPEC.md §5)
 * and the Passport strategies both need it. The caller is responsible for
 * having run migrations on that database before requests arrive
 * (`src/index.ts` and the tests do this).
 *
 * `opts.limiter` lets tests inject a deterministic (fixed-clock, low-budget)
 * rate limiter to exercise the 429 path; production uses the default
 * (300 requests / 15s per IP).
 */
export function createApp(db: AppDatabase, opts?: { limiter?: RateLimiter }): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : true,
    // The production backend sits behind nginx (frontend/nginx.conf), which is
    // the ONLY proxy hop and appends the real client IP to X-Forwarded-For;
    // in dev it listens directly with no proxy. `trustProxy: 1` trusts exactly
    // one hop, so `request.ip` resolves to the last (proxy-appended) XFF entry
    // when proxied and the socket IP otherwise — and, critically, a
    // client-controlled FIRST XFF entry is ignored (a bare `true` would trust
    // the whole chain and resolve to the first entry, i.e. trivially spoofable).
    // The rate limiter keys on `request.ip`, so this is its real client IP.
    trustProxy: 1,
  });

  (app as unknown as { db: AppDatabase }).db = db;

  void app.register(fastifyCookie);

  // Rate limiting (docs/SPEC.md §6/§12) — registered first so it guards every
  // route, including the unauthenticated auth endpoints, and rejects floods
  // before session deserialization runs. In-memory, single-process.
  registerRateLimit(app, opts?.limiter ?? createRateLimiter());

  // SQLite-backed session store (docs/SPEC.md §5: sessions survive restarts;
  // `connect-sqlite3` on the app's own connection, so one file holds both the
  // data and the sessions).
  const sqlite = (db as unknown as { session: { client: import('better-sqlite3').Database } }).session.client;
  const { store: sessionStore } = createSessionStore(sqlite);

  void app.register(fastifySession, {
    secret: resolveSessionSecret(),
    // The SQLite-backed store (src/session/sqliteStore.ts) matches the
    // express-session store shape at runtime; it is passed as `never` only
    // because `@fastify/session`'s bundled `SessionStore` interface is
    // narrower than its runtime behavior (see that file's doc comment).
    store: sessionStore as never,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_SEC,
      // Secure when serving over TLS (production behind a TLS terminator);
      // not hardcoding `false` (docs/SPEC.md §5).
      secure: process.env.NODE_ENV === 'production',
    },
  });

  // Auth routes (docs/SPEC.md §5) — the Google/GitHub OAuth2 flow is
  // hand-rolled in src/auth/oauth.ts (no Passport). The session holds only
  // `userId`; routes read/write `request.session` directly.
  void app.register(authRoutes, { prefix: '/api/auth' });
  void app.register(habitRoutes, { prefix: '/api' });

  // WebSocket milestone engine (docs/SPEC.md §8). `wsRoutes` attaches its own
  // `ws` WebSocketServer to the app's HTTP server and handles the `GET /ws`
  // upgrade directly — no `@fastify/websocket` plugin. The route is mounted at
  // the app root (not under `/api`) so the WS URL is `ws://<host>/ws`
  // (frontend builds it from `window.location`, docs/SPEC.md §9).
  void app.register(wsRoutes);

  app.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  return app;
}
