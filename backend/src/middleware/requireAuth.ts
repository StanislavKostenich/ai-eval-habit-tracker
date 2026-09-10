import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionLike } from '../types.js';

/**
 * Authentication guard for every non-`/api/auth/*` route (docs/SPEC.md §12):
 * unauthenticated requests get `401 { error: 'Unauthorized' }`.
 *
 * The session carries only `userId` (docs/SPEC.md §5). Fastify treats a
 * preHandler that returns `undefined` as "not yet handled" — so when
 * unauthenticated we send the 401 AND return `undefined` (never `false`,
 * which Fastify interprets as an aborted request).
 */
export function requireAuth(request: FastifyRequest, reply: FastifyReply): void {
  if (!(request.session as unknown as SessionLike).userId) {
    void reply.status(401).send({ error: 'Unauthorized' });
    return;
  }
}
