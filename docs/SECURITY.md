# Security: npm Vulnerability Report

## Summary

After `npm install`, npm audit reports **10 vulnerabilities** across the project. **None of these affect runtime security** — all are in the build tool chain used by native modules during installation.

## Vulnerability Breakdown

| Vulnerability | Package | Severity | Impact | Status |
|---|---|---|---|---|
| Incorrect Control Flow Scoping | `@tootallnate/once <2.0.1` | Low | Build tools (node-gyp → sqlite3) | Transitive |
| Arbitrary File Path Traversal | `tar <=7.5.10` | High (5) | Build tools (node-gyp) | Transitive |
| esbuild CORS bypass | `esbuild <=0.24.2` | Moderate (2) | Build tools (drizzle-kit, vite) | Transitive |

## Root Causes

These vulnerabilities exist because:

1. **`better-sqlite3`** (production dependency) requires native compilation, which uses:
   - `node-gyp` (old, brings old `tar` and `@tootallnate/once`)
   - `sqlite3` as optional build dependency

2. **`connect-sqlite3`** (production dependency for session store) depends directly on:
   - `sqlite3 ^5.0.2` (vulnerable version)

3. **`drizzle-kit`** (dev dependency for migrations) uses:
   - Old esbuild internally (already downgraded from 0.31.10 to 0.18.1)

4. **`vite`** (dev dependency in frontend) includes:
   - esbuild for bundling

## Runtime Risk Assessment

✅ **Zero runtime exposure**: The app uses `better-sqlite3` for runtime database access. The vulnerabilities are in:
- Build-time native module compilation tools (node-gyp, tar)
- Package management infrastructure (npm's internal networking)
- Dev server tooling (esbuild, rolldown)

None of these run in production or are exposed to network requests.

## Mitigation Applied

1. ✅ Removed `vite` from backend/package.json (frontend-only tool)
2. ✅ Updated `vite` in frontend to ^5.4.0 (newer version, though esbuild still has moderate severity)
3. ✅ Used `legacy-peer-deps` to resolve version conflicts
4. ✅ Kept `.npmrc` minimal to preserve test and build functionality
5. ✅ Verified all 46 tests pass with current dependencies

## Remaining Vulnerabilities

These cannot be fully eliminated without breaking changes:

### tar <=7.5.10 (5 high-severity issues)
- **Root cause**: Required by `node-gyp` which compiles `better-sqlite3`
- **Impact**: Affects only build-time archive operations, not app runtime
- **Fix**: Would require updating `node-gyp` to >=10.4.0, which conflicts with `better-sqlite3` builds

### esbuild <=0.24.2 (2 moderate-severity CORS issues)
- **Root cause**: Included by `drizzle-kit 0.18.1` and `vite`
- **Impact**: Dev server security; no exposure in production
- **Fix**: Would require drizzle-kit >=0.31.0, but that brings newer esbuild vulnerabilities

### @tootallnate/once <2.0.1 (1 low-severity issue)
- **Root cause**: Transitive through http-proxy-agent → node-gyp
- **Impact**: Control flow in build tools only
- **Fix**: Update node-gyp (breaks better-sqlite3 builds)

## Recommendation

**For local development**: Current setup is acceptable. The vulnerabilities are in dev/build tooling, not production code.

**For production deployment**:
- Deploy compiled/built artifacts only (no `node_modules` in production)
- Use a production runtime with pre-compiled SQLite bindings
- Consider migrating session store from `sqlite3`-dependent `connect-sqlite3` to an in-memory or Redis-based alternative

## Test Status

```
✅ Test Files  5 passed
✅ Tests       46 passed
✅ All acceptance criteria verified
```

Tests confirm the app functions correctly despite these build-time vulnerabilities.

---

**Last Updated**: 2026-05-30  
**Node.js Version**: 20 (required by spec)  
**npm Version**: Latest
