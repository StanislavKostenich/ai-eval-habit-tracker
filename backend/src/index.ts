import 'dotenv/config';
import { createApp } from './app.js';
import { getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';

// Apply generated migrations idempotently at startup (docs/SPEC.md §13).
// schema.ts is the single source of truth; no DDL lives here.
runMigrations();

const app = createApp(getDb()); // createApp(db) — db must be migrated (done above)

const port = Number(process.env.PORT ?? 3000);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    app.log.info(`backend ready on port ${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

export default app;
