import type BetterSqlite3 from 'better-sqlite3';
import connectSqlite3 from 'connect-sqlite3';

/**
 * Structural shapes of `@fastify/session`'s store contract. The package's
 * types come from a CJS `export =` namespace, which — like `fastify`'s
 * `export =` — cannot be imported as a namespace under `module: NodeNext`
 * from an ESM project (the namespace members don't survive the ESM
 * import-condition load). `@fastify/session` accepts any object with these
 * three methods, so the return type is structural.
 */
type SessionCallback = (err?: Error | null) => void;
type SessionStoreShim = {
  get(sessionId: string, callback: (err: Error | null, session?: unknown) => void): void;
  set(sessionId: string, session: unknown, callback: SessionCallback): void;
  destroy(sessionId: string, callback: SessionCallback): void;
};

/**
 * Minimal structural type for the subset of the async sqlite3 API that
 * `connect-sqlite3` uses against its `options.db` (exec/get/all/run).
 */
type AsyncSqliteLikeDb = {
  exec(sql: string, cb?: (err?: Error) => void): void;
  get<T>(sql: string, params: unknown[], cb: (err: Error | null, row?: T) => void): void;
  all<T>(sql: string, params: unknown[], cb: (err: Error | null, rows?: T[]) => void): void;
  run(sql: string, params: unknown[], cb: (err: Error | null, info?: unknown) => void): void;
};

/**
 * Wraps a synchronous better-sqlite3 connection in the callback-driven shape
 * `connect-sqlite3` expects.
 *
 * `connect-sqlite3` is written for the async `sqlite3` package and has two
 * quirks this wrapper has to absorb (verified against the installed source):
 * - it runs the `INSERT OR REPLACE` for `set()` through `.all()` — which
 *   throws "This statement does not return data" on better-sqlite3 — so
 *   statements that do not return rows are executed with `.run()`;
 * - its `dbCleanup` callback is `function (err) { throw err; }` invoked via
 *   `.all()`, so a thrown error there would be swallowed — all wrapper
 *   callbacks report results (and errors) through the callback only.
 */
function toAsyncSqliteLike(db: BetterSqlite3.Database): AsyncSqliteLikeDb {
  const stmt = (sql: string) => db.prepare(sql);
  const nextTickCall = (fn: () => void): void => {
    process.nextTick(() => {
      try {
        fn();
      } catch (err) {
        // Surface errors that slip through the callback path (see the
        // `dbCleanup` quirk above) as warnings instead of uncaught throws.
        process.emitWarning(String(err));
      }
    });
  };
  return {
    exec(sql, cb) {
      nextTickCall(() => {
        stmt(sql).run();
        cb?.();
      });
    },
    get(sql, params, cb) {
      nextTickCall(() => {
        const row = stmt(sql).get(...(params as never[])) ?? undefined;
        cb?.(null, row as never);
      });
    },
    all(sql, params, cb) {
      nextTickCall(() => {
        let rows: unknown[];
        try {
          rows = stmt(sql).all(...(params as never[]));
        } catch {
          // Statement does not return data (e.g. `INSERT OR REPLACE ...`
          // used by `connect-sqlite3.set`); execute it as a write instead.
          stmt(sql).run(...(params as never[]));
          rows = [];
        }
        cb?.(null, rows as never);
      });
    },
    run(sql, params, cb) {
      nextTickCall(() => {
        const info = stmt(sql).run(...(params as never[]));
        cb?.(null, info);
      });
    },
  };
}

/**
 * The connect-sqlite3 store instance, structurally narrowed to the three
 * methods the app's `SessionStore` adapter uses.
 */
type ConnectSqlite3Instance = {
  table?: string;
  get(sid: string, cb: (err: Error | null, session?: unknown) => void): void;
  set(sid: string, session: unknown, cb?: (err?: Error | null) => void): void;
  destroy(sid: string, cb?: (err?: Error | null) => void): void;
};

/**
 * Builds a SQLite-backed session store (docs/SPEC.md §5: "a SQLite-backed
 * (`connect-sqlite3` or equivalent) store in production so sessions survive
 * restarts") on top of an open better-sqlite3 connection.
 *
 * The connection must already have the Drizzle migrations applied (the app's
 * tables must exist); the `sessions` table itself is created by
 * `connect-sqlite3` on first use.
 */
export function createSessionStore(sqlite: BetterSqlite3.Database): {
  store: SessionStoreShim;
  clear(): void;
} {
  // `connect-sqlite3` internally does `Store.call(this, options)`, so the
  // passed-in Store must be an ordinary function, not the abstract ES class
  // its shipped types demand. Its `connect(ConnectParams)` parameter type
  // references the namespace `Store` declared behind `export = connect.connect`,
  // and under `module: NodeNext` that namespace member does not resolve as a
  // type from an ESM consumer — even a local structural stand-in fails the
  // assignability check (verified empirically). The runtime contract is an
  // ordinary function, so the parameter is widened here and only the
  // returned constructor is cast to the structural shape used below.
  const SQLiteStore = (
    connectSqlite3 as unknown as (opts: { Store: () => void; db: AsyncSqliteLikeDb }) => unknown
  )({
    Store: function connectStoreShim() {},
    db: toAsyncSqliteLike(sqlite),
  }) as unknown as new (options: { db: AsyncSqliteLikeDb }) => ConnectSqlite3Instance;

  const sqliteStore = new SQLiteStore({ db: toAsyncSqliteLike(sqlite) });
  const table = sqliteStore.table ?? 'sessions';

  return {
    store: {
      get(sessionId, callback) {
        sqliteStore.get(sessionId, (err, session) => {
          callback(err ?? null, session as never);
        });
      },
      set(sessionId, session, callback) {
        sqliteStore.set(sessionId, session, callback);
      },
      destroy(sessionId, callback) {
        sqliteStore.destroy(sessionId, callback);
      },
    },
    clear() {
      sqlite.prepare(`DELETE FROM ${table}`).run();
    },
  };
}
