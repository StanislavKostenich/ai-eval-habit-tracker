import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyWebsocket from '@fastify/websocket';
import passport from 'passport';
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type { AppDatabase } from './db/index.js';
import { registerPassport } from './auth/passport.js';
import { createSessionStore } from './session/sqliteStore.js';
import authRoutes from './routes/auth.js';
import habitRoutes from './routes/habits.js';
import wsRoutes from './ws/handler.js';

/** 24 hours in seconds — session cookie lifetime (docs/SPEC.md §5). */
const SESSION_MAX_AGE_SEC = 24 * 60 * 60;

/**
 * Dev-only fallback for SESSION_SECRET. Never used in production: boot
 * hard-fails there when SESSION_SECRET is missing or shorter than 32 chars
 * (docs/SPEC.md §3).
 */
const DEV_SESSION_SECRET_FALLBACK = 'dev-only-insecure-session-secret-0123456789';

function resolveSessionSecret(log: { warn: (msg: string) => void }): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const secret = process.env.SESSION_SECRET;

  if (isProduction) {
    if (!secret || secret.length < 32) {
      throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters in production');
    }
    return secret;
  }

  if (!secret) {
    log.warn(
      `SESSION_SECRET not set — using an insecure development fallback (set SESSION_SECRET in .env; production boot hard-fails without one)`,
    );
    return DEV_SESSION_SECRET_FALLBACK;
  }

  if (secret.length < 32) {
    log.warn(`SESSION_SECRET is shorter than 32 characters — weak secret in use`);
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
 */
export function createApp(db: AppDatabase): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : true,
  });

  (app as unknown as { db: AppDatabase }).db = db;

  void app.register(fastifyCookie);

  // SQLite-backed session store (docs/SPEC.md §5: sessions survive restarts;
  // `connect-sqlite3` on the app's own connection, so one file holds both the
  // data and the sessions).
  const sqlite = (db as unknown as { session: { client: import('better-sqlite3').Database } }).session.client;
  const { store: sessionStore } = createSessionStore(sqlite);

  void app.register(fastifySession, {
    secret: resolveSessionSecret(app.log),
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

  // Passport (docs/SPEC.md §5, Option A): the strategies are configured here
  // and actually invoked from the auth routes via passport.authenticate.
  // passport.session() makes passport read/write its login marker in
  // req.session — with serializeUser/deserializeUser round-tripping only the
  // user id, so the session holds just `userId` (see auth/passport.ts).
  registerPassport(db, app.log);
  // Passport's middleware is typed for Express's Request/Response; Fastify's
  // raw node request/response pair satisfies the runtime contract. The casts
  // are structural (see the `http` module augmentation in src/types.d.ts).
  // Passport's middleware is typed for Express's Request/Response; Fastify's
  // raw node request/response pair satisfies the runtime contract, so the
  // casts are structural (node types, no `any`).
  const passportInit = passport.initialize() as unknown as (
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    done: (err?: Error) => void,
  ) => void;
  const passportSess = passport.session() as unknown as (
    req: FastifyRequest['raw'],
    res: FastifyReply['raw'],
    done: (err?: Error) => void,
  ) => void;
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
    passportInit(request.raw, reply.raw, done);
  });
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
    // @fastify/session attaches the session to `request.session` (the Fastify
    // request object), but passport.session() looks for it on the raw Node
    // request (`request.raw.session`). Bridge the two so passport can read
    // and write the session.
    (request.raw as unknown as Record<string, unknown>).session = request.session;
    passportSess(request.raw, reply.raw, done);
  });

  void app.register(authRoutes, { prefix: '/api/auth' });
  void app.register(habitRoutes, { prefix: '/api' });

  // WebSocket milestone engine (docs/SPEC.md §8). The plugin must be registered
  // before the `/ws` route; the route is mounted at the app root (not under
  // `/api`) so the WS URL is `ws://<host>/ws` (frontend builds it from
  // `window.location`, docs/SPEC.md §9).
  void app.register(fastifyWebsocket);
  void app.register(wsRoutes);

  app.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  return app;
}
