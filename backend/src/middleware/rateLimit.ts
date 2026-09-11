import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * In-memory sliding-window rate limiter (docs/SPEC.md §6/§12).
 *
 * The spec names "rate limiting and log monitoring on auth endpoints" as the
 * mitigation for the 404-vs-403 user-enumeration concern, so a limiter is part
 * of the contract, not optional. It is deliberately dependency-free (no
 * `@fastify/rate-limit`, which would pull in `@fastify/under-pressure` and add
 * a Redis/store option we don't need): a single Node process + SQLite means an
 * in-memory map is sufficient for this deployment.
 *
 * Keyed by client IP, with a fixed window and a request cap. When a client
 * exceeds the cap they get `429 { error }` and the request is aborted before
 * reaching any handler. Every response — allowed or rejected — also carries
 * `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers so
 * clients can see their budget (docs/SPEC.md §14 checklist).
 *
 * Registered as the FIRST `onRequest` hook (before the passport/session hooks
 * in `app.ts`) so it guards every route — including the unauthenticated
 * `demo-login` and OAuth kickoffs — and rejects floods before session
 * deserialization is done.
 */

const RATE_LIMIT_WINDOW_MS = 15_000;
const RATE_LIMIT_MAX = 300;

/** The outcome of recording one request against a client's budget. */
export interface RateLimitResult {
  /** False when this request exceeds the window budget (the hook returns 429). */
  allowed: boolean;
  /** The window's configured maximum request count. */
  limit: number;
  /** Requests left in the window after this one (clamped at 0). */
  remaining: number;
  /** Unix-ms when the window budget refreshes (oldest in-window hit + window). */
  resetAt: number;
}

/** One limiter: an in-memory map of IP → timestamped request count. */
export interface RateLimiter {
  /** Record a request for `ip`; report whether it is allowed and the budget state. */
  hit: (ip: string) => RateLimitResult;
}

export function createRateLimiter(opts?: {
  windowMs?: number;
  max?: number;
  now?: () => number;
}): RateLimiter {
  const windowMs = opts?.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const max = opts?.max ?? RATE_LIMIT_MAX;
  const now = opts?.now ?? Date.now;

  const hits = new Map<string, number[]>();

  return {
    hit(ip: string): RateLimitResult {
      const t = now();
      const cutoff = t - windowMs;
      const prev = hits.get(ip);
      // Drop timestamps that have aged out of the window, then append this hit.
      const recent = (prev ?? []).filter((ts) => ts > cutoff);
      recent.push(t);
      hits.set(ip, recent);
      // Prune stale IPs opportunistically so the map doesn't grow unbounded.
      if (hits.size > 10_000) {
        for (const [key, arr] of hits) {
          const kept = arr.filter((ts) => ts > cutoff);
          if (kept.length === 0) hits.delete(key);
          else hits.set(key, kept);
        }
      }
      return {
        allowed: recent.length <= max,
        limit: max,
        remaining: Math.max(0, max - recent.length),
        // The window clears once the oldest in-window hit ages out. This hit
        // was just appended, so the array is never empty here.
        resetAt: (recent[0] ?? t) + windowMs,
      };
    },
  };
}

/**
 * Wires a rate limiter into the app's request pipeline. Returns the limiter so
 * tests can construct it deterministically (fixed clock) and inspect behavior.
 */
export function registerRateLimit(app: FastifyInstance, limiter: RateLimiter): { limiter: RateLimiter } {
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    // `request.ip` is the client address: the socket IP when there is no proxy,
    // or the last (proxy-appended) X-Forwarded-For entry when Fastify is created
    // with `trustProxy: true` (see app.ts). Never read X-Forwarded-For by hand —
    // the client-controlled entries are the first ones, and a naive
    // first-entry parse is trivially spoofable (rate-limit bypass).
    const result = limiter.hit(request.ip);

    // Budget headers on every response — allowed and rejected alike
    // (docs/SPEC.md §14). `reply.header` here runs in the onRequest phase,
    // before the handler, so they land on the eventual response.
    reply.header('RateLimit-Limit', result.limit);
    reply.header('RateLimit-Remaining', result.remaining);
    reply.header('RateLimit-Reset', Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      void reply.status(429).send({ error: 'Too many requests' });
      return;
    }
    done();
  });
  return { limiter };
}
