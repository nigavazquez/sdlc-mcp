# Task C2 Report: Boot-time Org Structure Reconciliation

## Status
DONE — all tests pass, full suite green.

---

## TDD Cycle

### RED
Wrote `apps/server/test/reconcile.test.ts` with 4 test cases:
1. Creates missing workspaces/groups, reports drift without deleting (brief's canonical test)
2. Idempotent: second call on same config creates nothing
3. Drift only includes workspace IDs absent from config (not those present in both)
4. Groups are created before the workspaces that reference them

Ran `pnpm --filter @sdlc/server test reconcile` → **FAIL** (module not found, as expected).

### GREEN
Implemented `apps/server/src/config/reconcile.ts`:
- Loads existing group IDs via `listGroups()` into a Set; creates missing ones (no `getGroup` needed, Set membership avoids dups).
- Checks each config workspace via `getWorkspace(id)` before calling `createWorkspace`; maps `cfg.workspace.group` → `group_id`.
- Collects drift by iterating `listWorkspaces()` result and checking against the config ID Set.
- Emits `log.warn` per drift id; `log.info` per creation.
- Returns `{ created: string[], drift: string[] }`.

Ran again → **4/4 PASS**.

---

## Drift / No-Delete Evidence

Test "reporta drift sólo para workspaces ausentes del config":
- Pre-populates store with `old-ws` and `new-ws`.
- Config only contains `new-ws`.
- After reconcile: `drift` contains `old-ws`, not `new-ws`.
- `store.getWorkspace('old-ws')` still returns a record (never deleted).
- `log.warn` was called with a message containing `"old-ws"`.

---

## Boot-Wiring Approach

### `apps/server/src/config.ts`
Added `sdlcConfigPath` field:
```typescript
sdlcConfigPath: z.string().default('./sdlc.config.yaml'),
```
Reads from `process.env.SDLC_CONFIG`.

### `apps/server/src/index.ts`
Added imports for `loadFileConfig` and `reconcileStructure`. Added reconcile block after the Fastify app instance is created (so `app.log` is available) but before `app.listen`:

```typescript
if (config.databaseUrl) {
  const fileCfg = loadFileConfig(config.sdlcConfigPath);
  if (fileCfg) {
    app.log.info({ path: config.sdlcConfigPath }, 'reconciling org structure from config');
    const result = await reconcileStructure(adminStoreHandle.store, fileCfg, app.log);
    app.log.info({ created: result.created, drift: result.drift }, 'reconcile complete');
  }
}
```

Guard: `config.databaseUrl` must be set (persistent store). In dev/demo mode (no DATABASE_URL), reconcile is skipped.

---

## Files Changed

| File | Action |
|------|--------|
| `apps/server/src/config/reconcile.ts` | Created |
| `apps/server/test/reconcile.test.ts` | Created |
| `apps/server/src/config.ts` | Added `sdlcConfigPath` field + env mapping |
| `apps/server/src/index.ts` | Added imports + boot reconcile block |

---

## Full Suite Result

```
Test Files  52 passed | 7 skipped (59)
     Tests  340 passed | 26 skipped (366)
  Duration  6.28s
Tasks:      9 successful, 9 total
```

Typecheck: **PASS** (zero TS errors).

---

## Self-Review

- **Idempotency**: Groups checked via Set from `listGroups()`; workspaces via `getWorkspace()`. Both safe to call every boot.
- **No new store methods**: AdminStore interface unchanged. Uses only existing `listGroups`, `listWorkspaces`, `getWorkspace`, `createGroup`, `createWorkspace`.
- **No deletes**: `reconcileStructure` only reads and creates; drift is reported but never acted upon destructively.
- **Field mapping**: FileConfig uses `.id`/`.group`; AdminStore uses `.workspace_id`/`.group_id`. Mapping done explicitly in reconcile.
- **Boot guard**: Reconcile is wrapped in `if (config.databaseUrl)` so in-memory/demo mode is unaffected.
- **Logger**: Uses the Fastify `app.log` (pino-compatible) interface matching the `{ info(msg): void; warn(msg): void }` signature expected by reconcileStructure.
