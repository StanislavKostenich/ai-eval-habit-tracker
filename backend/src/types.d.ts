/**
 * Session type declaration for the backend.
 *
 * NOTE: this is intentionally NOT a `declare module 'fastify'` augmentation.
 * Under `module: NodeNext`, an in-project augmentation of a CJS
 * `export =` package (fastify v4) makes TypeScript build a synthetic
 * namespace for the ESM `import` condition that drops the callable
 * `default` and all named exports — breaking every `Fastify()`,
 * `FastifyInstance`, `FastifyRequest.raw`, etc. throughout the project.
 *
 * The session is typed structurally instead (docs/SPEC.md §5: the session
 * holds only `userId: string`):
 *
 *   const userId: string | undefined = (request.session as { userId?: string }).userId;
 */
export type SessionLike = {
  userId?: string;
};
