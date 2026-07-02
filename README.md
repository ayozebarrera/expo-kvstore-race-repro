# expo-sqlite `kv-store` — `no such table: storage` repro

Minimal reproduction for a bug in `expo-sqlite/kv-store` (`SQLiteStorage`):

1. **`getDbSync()` bypasses the `awaitLock`** that `getDbAsync()` uses. When the
   sync and async APIs touch the **same database file** during first launch,
   their first-run migrations can run concurrently on the file with no shared
   lock. This is the sync/async residual of
   [#33754](https://github.com/expo/expo/issues/33754) (closed via #33834, which
   only serialized the **async** path).

2. **The migration is not self-healing.** `maybeMigrateDbSync` /
   `maybeMigrateDbAsync` return early whenever `user_version >= DATABASE_VERSION`
   and only run `CREATE TABLE ... storage` while `user_version === 0`. So if a DB
   ever ends up with `user_version` bumped but the `storage` table missing (which
   is exactly what an interrupted/raced first-run migration produces), the table
   is **never recreated** and every call throws:

   ```
   SQLiteErrorException: Error code 1: no such table: storage
   ```

## Run

```bash
npm install
npx expo run:ios      # or: npx expo run:android   (a dev build; expo-sqlite is native)
```

Then:

- **Run A — deterministic (100%).** Recreates the exact broken state
  (`user_version = 1`, no `storage` table) and calls `getItemSync` through a
  normal `SQLiteStorage`. It throws `no such table: storage`, proving the store
  cannot recover from that state. See `reproUnrecoverable` in `App.js`.

- **Run B — organic race (best-effort).** Fires `getItem()` (async) and
  `getItemSync()` (sync, unlocked) concurrently against fresh databases and
  reports any errors that surface. Timing dependent (as noted in #33754), so it
  may need a few runs. See `reproRace` in `App.js`.

## Expected vs actual

- **Expected:** sync/async init are mutually exclusive (or the migration verifies
  the table exists even when `user_version >= DATABASE_VERSION` and recreates it),
  so a raced first launch cannot brick the store.
- **Actual:** the DB is left with `user_version = 1` and no `storage` table, and
  `kv-store` throws `no such table: storage` on every subsequent call, forever.

## Suggested fixes (any one)

1. Guard `getDbSync()` init against a concurrent async init.
2. Make `maybeMigrateDb*` verify the `storage` table exists even when
   `user_version >= DATABASE_VERSION` and `CREATE TABLE IF NOT EXISTS` it (self-heal).
3. Eagerly initialize the connection in the constructor (suggested in #33754).

All logic is in [`App.js`](./App.js).
