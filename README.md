# @devioarts/capacitor-sqlite

SQLite plugin for Capacitor — iOS, Android, Web (OPFS), and Electron.

- Schema migrations via `PRAGMA user_version` — each version runs in its own transaction
- Thread-safe serialized SQLite work (serial queues on iOS and Android)
- Full transaction control: `beginTransaction` / `commitTransaction` / `rollbackTransaction`
- In-memory databases via `':memory:'`
- No encryption, no JSON import/export, no sync tables

## Installation

```bash
npm install @devioarts/capacitor-sqlite
npx cap sync
```

### Web

The web implementation uses [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm) with the OPFS backend. It is installed as a runtime dependency of this package.

OPFS requires the page to be served with cross-origin isolation headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check `isAvailable()` at startup — `':memory:'` databases still work on web even when OPFS is unavailable. The bundled sqlite-wasm OPFS VFS requires SharedArrayBuffer/COOP/COEP support and is not compatible with Safari versions below 17.

OPFS sync access handles are exclusive. Do not open the same persistent database from
two tabs, windows, workers, or hot-reload survivors at the same time; the second context
may fail writes with `SQLITE_IOERR`. Close the database or reload the stale context before
continuing. `':memory:'` databases are not affected.

### Electron

Uses Node's built-in `node:sqlite` module from a dedicated worker thread so synchronous database work does not block Electron's main process. Electron must expose Node 24+ `node:sqlite` at runtime; call `isAvailable()` to detect unsupported Electron/Node versions. Register the plugin in your Electron main process:

```ts
// electron/src/index.ts
import { app } from 'electron';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite/electron';
import { pluginSettings } from '@devioarts/capacitor-sqlite/electron/settings';

// For custom IPC, expose CapacitorSqlite from the main process after app.whenReady().
const capacitorSqlite = new CapacitorSqlite();

// Release the worker thread (and let SQLite flush its WAL) before the process exits.
app.on('before-quit', () => {
  void capacitorSqlite.dispose();
});
```

Databases are stored in `app.getPath('userData')/CapacitorSQLite/<name>.db` by default.

`CapacitorSqlite` lazily spawns its worker thread on first use and keeps it alive for the
life of the process. Call `dispose()` (not part of the shared `CapacitorSqlitePlugin`
interface — an Electron-only addition) to terminate it explicitly; a later call spawns a
fresh worker on demand, so `dispose()` is also safe to use to recover from a worker stuck
in a bad state.

## Quick start

```ts
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';

// Check platform support
const availability = await CapacitorSqlite.isAvailable();
if (!availability.success || !availability.data.available) {
  throw new Error(availability.success ? 'SQLite is not available' : availability.error.message);
}

// Open (or create) a database and run migrations
const opened = await CapacitorSqlite.open({
  database: 'myapp',
  migrations: [
    {
      version: 1,
      statements: ['CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'],
    },
  ],
});
if (!opened.success) throw new Error(opened.error.message);

// Insert
const inserted = await CapacitorSqlite.run({
  database: 'myapp',
  statement: 'INSERT INTO users (name) VALUES (?)',
  values: ['Alice'],
});
if (!inserted.success) throw new Error(inserted.error.message);
console.log('Inserted row id:', inserted.data.lastInsertId);

// Query
const queried = await CapacitorSqlite.query<{ id: number; name: string }>({
  database: 'myapp',
  statement: 'SELECT * FROM users',
});
if (!queried.success) throw new Error(queried.error.message);
console.log('Rows:', queried.data.rows);

// Close
await CapacitorSqlite.close({ database: 'myapp' });
```

## Database file location

By default the plugin stores each database in a per-platform directory:

| Platform | Default path                                                             |
| -------- | ------------------------------------------------------------------------ |
| iOS      | `<Library/Application Support>/CapacitorSQLite/<name>.db`                |
| Android  | `<filesDir>/CapacitorSQLite/<name>.db`                                   |
| Web      | OPFS — `file:<name>.db?vfs=opfs` (origin-scoped, no custom path support) |
| Electron | `app.getPath('userData')/CapacitorSQLite/<name>.db`                      |

The directory is created automatically if it does not exist.

Use the `directory` option to choose one of the supported logical locations. Raw absolute
or relative filesystem paths are not accepted.
On iOS and Electron, open database registry keys are matched case-insensitively
to avoid two handles pointing at the same file on case-insensitive filesystems.

```ts
await CapacitorSqlite.open({
  database: 'myapp',
  directory: 'library',
});
```

| `directory`         | iOS                                                     | Android                                                                                                  | Web                            | Electron                                           | Backup expectation                                                                                          |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| omitted / `default` | `Library/Application Support/CapacitorSQLite/<name>.db` | `<filesDir>/CapacitorSQLite/<name>.db`                                                                   | OPFS `file:<name>.db?vfs=opfs` | `userData/CapacitorSQLite/<name>.db`               | Backed up on iOS and Android by default; Electron `userData` may be cloud-backed by the OS/user environment |
| `library`           | `Library/Application Support/CapacitorSQLite/<name>.db` | `<filesDir>/CapacitorSQLite/<name>.db`                                                                   | OPFS fallback                  | `userData/CapacitorSQLite/<name>.db`               | Same as `default`; recommended for persistent app databases                                                 |
| `documents`         | `Documents/CapacitorSQLite/<name>.db`                   | app-specific external Documents if available, otherwise `<filesDir>/Documents/CapacitorSQLite/<name>.db` | OPFS fallback                  | Falls back to `userData/CapacitorSQLite/<name>.db` | Backed up on iOS/Android by default; use only for user-document/export-style data                           |
| `cache`             | `Library/Caches/CapacitorSQLite/<name>.db`              | `<cacheDir>/CapacitorSQLite/<name>.db`                                                                   | OPFS fallback                  | `temp/capacitor-sqlite/CapacitorSQLite/<name>.db`  | Not intended for cloud backup; OS may delete cache data                                                     |

> **Web:** all directory values use OPFS because browsers do not expose native app
> directory paths to the plugin.

> **Electron:** `documents` intentionally falls back to `userData` so an app database
> is not placed directly in the user's visible Documents folder.

> **`:memory:`:** the `directory` option is ignored for in-memory databases.

## Migrations

`open()` reads `PRAGMA user_version`, then runs every migration whose `version` exceeds the stored value (ascending order). Migration versions must be positive integers no greater than `2147483647` (2^31-1) on every platform — this matches the 32-bit field SQLite itself uses to store `user_version`. Each migration runs in its own transaction — if it fails the transaction is rolled back and `open()` returns a failure result. Migrations already applied on previous launches are skipped automatically. Versions must be unique within each `open()` call; duplicates return `MIGRATION_FAILED`.

Because each migration commits independently, a multi-version `migrations` list is **not**
atomic as a whole: if version 3 of 5 fails, versions 1 and 2 remain durably applied (`user_version`
included) even though `open()` as a whole returns a failure. Retrying `open()` resumes from
the first still-pending version rather than restarting from scratch.

Calling `open()` again for an already-open database reuses the connection when the
`readonly` mode and `directory` match. If `migrations` are supplied, pending versions
are applied before the call succeeds; already-applied versions remain idempotent. A
reopen with migrations while a manual transaction is active returns `MIGRATION_FAILED`
so migration SQL cannot be mixed into application transaction state. Reopening with a
different `readonly` value or `directory` returns `DB_ALREADY_OPEN`.

```ts
await CapacitorSqlite.open({
  database: 'myapp',
  migrations: [
    {
      version: 1,
      statements: [
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
        'CREATE INDEX idx_users_name ON users (name)',
      ],
    },
    {
      version: 2,
      statements: ['ALTER TABLE users ADD COLUMN email TEXT'],
    },
  ],
});
```

## Batch inserts

`runBatch()` executes multiple statements in a single native call — significantly faster than looping `run()` because it avoids repeated JS→native bridge roundtrips:

```ts
await CapacitorSqlite.runBatch({
  database: 'myapp',
  set: [
    { statement: 'INSERT INTO users (name) VALUES (?)', values: ['Bob'] },
    { statement: 'INSERT INTO users (name) VALUES (?)', values: ['Carol'] },
  ],
});
```

On web, persistent OPFS writes are especially sensitive to autocommit overhead. Prefer
`runBatch()` or an explicit transaction for groups of writes instead of many sequential
single-row `run()` calls.

With its default `transaction: true`, `runBatch()` validates the complete set before
the first write. Android and iOS reuse one prepared statement for repeated identical SQL
and read the connection change counter once around the complete batch; this avoids
per-row prepare and metadata queries without changing atomicity or the returned
`changes`. `transaction: false` deliberately retains per-statement autocommit semantics.

When every operation uses the same SQL, `runMany()` avoids repeating that SQL in every
item. Android, iOS, and Electron prepare one reusable statement for the loop; Web's
sqlite-wasm Worker1 keeps the same compact request even though it does not expose a
persistent prepared-statement handle:

```ts
await CapacitorSqlite.runMany({
  database: 'myapp',
  statement: 'INSERT INTO users (name) VALUES (?)',
  values: [['Bob'], ['Carol']],
});
```

Set `returnResults: true` only when each execution's `changes` and `lastInsertId` is
needed; omitting the per-item response minimizes bridge output. `runBatch()` remains the
general form for batches containing different SQL statements.

On native mobile platforms, an explicit transaction removes repeated SQLite commit/fsync
cost, but it does **not** remove the JS→native bridge roundtrip for every individually
awaited `run()`. `Promise.all()` with thousands of `run()` calls is therefore a bridge
fan-out benchmark, not a bulk-insert API: every item still has its own plugin call,
native queue entry, result object, and callback back to JavaScript. For hundreds or
thousands of rows, send chunks through `runBatch()` for mixed SQL or `runMany()` for one
repeated statement.

Mixed read/write fan-out against one database is serialized by design. A long burst of
writes can delay reads submitted at the same time, especially on iOS where thousands of
small plugin calls have noticeably higher callback/queue-drain overhead than one batch.
Use one-call writes (`runMany()`/`runBatch()`), smaller chunks, or explicit application
scheduling when read latency matters during imports.

SQLite query planning is still your responsibility. A filtered query such as
`WHERE id > ? ORDER BY id DESC LIMIT 100` scans and sorts the whole table without an
index, even though the plugin overhead is small. Add an index matching the filter/order
columns (for example `CREATE INDEX ... ON table(id)`) when this pattern is latency
sensitive.

Benchmark the public API in the same build and WebView/browser mode used by the real
application. Debugger attachment, remote console collection, a visible benchmark UI,
WebView scheduling, thermal throttling, and background/foreground transitions can change
per-call latency without changing SQLite execution time. Compare a minimal query, a write
inside one transaction, an autocommit write, and a one-call batch/runMany workload; a
single aggregate “load-test duration” cannot identify which layer is slow.

For persistent Web databases, each autocommit write includes an OPFS durability barrier.
This is intentional durability, not SQL planning time or general plugin overhead. A loop
or `Promise.all()` fan-out of thousands of individual `run()` writes therefore multiplies
that per-row durable commit cost. Grouping writes with `runMany()`, `runBatch()`, or an
explicit transaction removes the repeated barriers while preserving one durable commit
for the group.
For Electron, regenerate the consuming application's main/preload plugin registry after
upgrading to a version that adds a method. `runMany()` includes a compatibility path for
an older registry, but the regenerated registry is required to use its fast native
repeated-statement implementation.
If a manual transaction is already active, call `runBatch({ ..., transaction: false })`
so the batch participates in that transaction without attempting to nest another one.

## Transactions

```ts
const begun = await CapacitorSqlite.beginTransaction({ database: 'myapp' });
if (!begun.success) throw new Error(begun.error.message);
try {
  const updated = await CapacitorSqlite.run({ database: 'myapp', statement: 'UPDATE ...', values: [...] });
  if (!updated.success) throw new Error(updated.error.message);
  const batched = await CapacitorSqlite.runBatch({ database: 'myapp', set: [...], transaction: false });
  if (!batched.success) throw new Error(batched.error.message);
  const committed = await CapacitorSqlite.commitTransaction({ database: 'myapp' });
  if (!committed.success) throw new Error(committed.error.message);
} catch (e) {
  const rolledBack = await CapacitorSqlite.rollbackTransaction({ database: 'myapp' });
  if (!rolledBack.success && rolledBack.error.code !== 'TRANSACTION_FAILED') {
    console.error('Rollback failed:', rolledBack.error);
  }
  throw e;
}
```

Every plugin method resolves to `SqliteResult`; SQL failures do not reject the Promise.
Therefore transaction code must inspect `success` as above—`try`/`catch` alone does not
trigger rollback for a failed `run()`, `runBatch()`, or `commitTransaction()`.

Manual transactions are connection-scoped. Calling `beginTransaction()` again, or calling
`execute()` / `runBatch()` with their default `transaction: true` while a manual transaction
is active, returns `TRANSACTION_FAILED`.

`close()` automatically rolls back any open transaction.

## In-memory databases

Pass `':memory:'` as the database name for an ephemeral, in-memory database — useful in tests or for temporary scratch space:

```ts
await CapacitorSqlite.open({ database: ':memory:' });

await CapacitorSqlite.execute({
  database: ':memory:',
  statements: ['CREATE TABLE t (x INTEGER)'],
});
```

In-memory databases are not persisted. On iOS, Web, and Electron, `close()` destroys the
database — a subsequent `open({ database: ':memory:' })` always starts from a fresh, empty
database. On Android, `SQLiteDatabase`'s connection pool has been observed (device testing,
`mdb-02` in the shared suite) to keep a `:memory:` database's contents alive across a
close/reopen cycle; use explicit cleanup SQL (e.g. `DROP TABLE`) when you need a guaranteed
reset on Android.

## Value types

| JS type      | SQLite affinity     |
| ------------ | ------------------- |
| `string`     | TEXT                |
| `number`     | INTEGER / REAL      |
| `boolean`    | INTEGER (`0` / `1`) |
| `null`       | NULL                |
| `Uint8Array` | BLOB                |

For BLOB parameters prefer `Uint8Array`. A plain `number[]` (each item `0–255`) is also
accepted by the native (iOS/Android) and Electron implementations, but the **web**
implementation accepts `Uint8Array` only. Because the Capacitor bridge does not transport
typed arrays natively, the JS wrapper sends Android/iOS BLOB inputs as a private tagged
base64 envelope and native code decodes directly to `ByteArray`/`Data`. Ordinary strings,
including marker-looking strings, remain TEXT. Electron and Web retain `Uint8Array`
through structured clone and do not use the native JSON envelope. Keep individual bridge
payloads reasonably bounded; for multi-megabyte media, storing files outside SQLite and
persisting references usually has a lower memory peak.

`number` values must be finite. Integer `number` values must be within
`Number.MAX_SAFE_INTEGER`. SQLite INTEGER query results outside JavaScript's safe
integer range are returned as strings instead of imprecise numbers.

## Parameter placeholders

Use anonymous `?` placeholders with `values: [...]` in the same order:

```ts
await CapacitorSqlite.query({
  database: 'myapp',
  statement: 'SELECT * FROM users WHERE id = ? AND active = ?',
  values: [123, true],
});
```

Numbered placeholders (`?1`) and named placeholders (`:name`, `@name`, `$name`)
are valid SQLite syntax, but are rejected by this plugin's cross-platform contract.
The plugin exposes positional arrays, not named bind objects. The number of supplied
values must exactly equal the number of real anonymous `?` placeholders; placeholders
inside strings, quoted identifiers, and SQL comments are ignored by the count scanner.

On Android, `query()` has to use `SQLiteDatabase.rawQuery(sql, String[])`, which
only accepts string bind arguments. To preserve SQLite types, the plugin scans SQL
before `rawQuery()` and safely inlines numeric, boolean, and BLOB values as SQL
literals. The scanner ignores `?` inside string literals, quoted identifiers, and
SQL comments, and rejects unsupported numbered/named placeholder forms.

## SQL trust boundary

This plugin validates database names and storage directories, and it supports
parameterized bind values. It does not sandbox arbitrary SQL text. Treat every
`statement` and every string in `execute().statements` or migration definitions as
trusted application code.

Do not pass user-authored SQL into the plugin. Bind user data through `values`
instead of string concatenation. Parameter binding protects values, but it does not
make dangerous SQL commands safe if the SQL text itself is untrusted.

## Platform notes

|              | iOS                                  | Android                   | Web                                              | Electron                  |
| ------------ | ------------------------------------ | ------------------------- | ------------------------------------------------ | ------------------------- |
| Storage path | Application Support/CapacitorSQLite/ | filesDir/CapacitorSQLite/ | OPFS                                             | userData/CapacitorSQLite/ |
| WAL mode     | ✓                                    | ✓                         | Not supported by sqlite-wasm                     | ✓                         |
| `:memory:`   | ✓                                    | ✓                         | ✓                                                | ✓                         |
| Min version  | iOS 15                               | API 24                    | OPFS VFS + SharedArrayBuffer support; Safari 17+ | Electron 40+ (Node 24+)   |

### Cross-platform caveats

A few behaviours differ between platforms. None block normal use, but they matter for
correctness-sensitive code:

- **One statement per SQL string.** Each element of `execute().statements[]`, each
  `run().statement`, each `runBatch().set[].statement`, and each migration statement
  must contain exactly one SQL statement. Multiple statements packed into one string
  (`"INSERT …; INSERT …"`) return a failure on every platform.
- **Android `query()` placeholder scanning.** Android's `rawQuery()` accepts only
  string bind args, so the plugin scans SQL and inlines numeric, boolean, and BLOB
  `?` values as SQL literals to preserve types. Use only anonymous `?`
  placeholders; numbered/named placeholders are intentionally not supported.
- **Android row-returning PRAGMA statements.** Android's `execute()` uses
  `SQLiteDatabase.execSQL()`, which rejects SQL that returns a result row. For PRAGMA
  statements such as `journal_mode` that report a value, use `query()` instead; PRAGMA
  statements that do not return rows, such as `PRAGMA foreign_keys = ON`, can still be
  run through `execute()`.
- **Call ordering and multi-database scheduling.** Calls against a database are serialized
  for safety. Always `await` transaction boundaries (`beginTransaction` / `commitTransaction` /
  `rollbackTransaction`) before issuing dependent work. On **both** Android and iOS, every
  plugin call — across _all_ open databases — is funneled through a single native SQLite
  thread/serial queue (Android: one executor thread; iOS: one serial work queue in front of
  each database's own connection queue), so manual transactions stay on the same native
  thread. Apps that keep only one database open are not affected. If you keep multiple
  databases open on Android or iOS, a long operation on DB-A delays calls to DB-B until it
  leaves the shared queue. Web and Electron also use one underlying SQLite worker per
  plugin instance, while maintaining a separate logical FIFO for each database; a long
  synchronous SQLite call can therefore still delay work for another database.
- **Performance and bridge calls.** A manual transaction removes durable commit cost but
  does not remove an awaited JS↔native round-trip per `run()`. `Promise.all()` with many
  `run()` calls does not collapse those calls into one SQLite operation; it creates many
  bridge requests and many callbacks. Use `runBatch()` for mixed bulk writes or
  `runMany()` for one repeated statement. Mixed reads and writes against the same database
  are serialized, so reads submitted behind a large write fan-out may wait for the queued
  writes to drain. Web mirrors connection rowid state so a successful `run()` needs one
  worker request instead of a preliminary metadata request plus execution; errors
  resynchronize the mirror before the next call. Web OPFS autocommit intentionally
  persists each write and is much slower than writes grouped in a transaction. Android,
  iOS, and Electron renderer queries use a compact internal columns-plus-values
  representation across native/worker boundaries and reconstruct the unchanged documented
  row objects only in JavaScript; this internal format is not API.
- **Query planning and indexes.** The plugin does not create indexes automatically or
  rewrite application SQL. Large filtered/sorted queries need appropriate SQLite indexes;
  otherwise SQLite may perform a full table scan and temporary sort (`EXPLAIN QUERY PLAN`
  reports this as `SCAN ...` and `USE TEMP B-TREE FOR ORDER BY`). Add indexes that match
  frequent `WHERE` / `ORDER BY` patterns before treating these queries as plugin overhead.
- **UPSERT and `lastInsertId`.** `run()`'s `lastInsertId` is `0` for any statement containing
  an `ON CONFLICT` clause, not just for statements with zero `changes`. SQLite only updates
  the underlying rowid counter on a genuine `INSERT`, not on the `DO UPDATE` arm of an
  upsert's conflict resolution, so a naive `changes > 0` check cannot reliably tell which
  row an upsert affected. Use `query()` with a `RETURNING` clause to get the affected row's
  id from an `INSERT … ON CONFLICT … DO UPDATE` statement.
- **Ambiguous unchanged rowids.** SQLite exposes `last_insert_rowid()` as connection
  state, not as an unambiguous per-statement result. `run()` therefore returns `0` when
  that counter did not change—for example after inserting into a `WITHOUT ROWID` table,
  replacing the same explicit rowid, or reusing a deleted rowid. Use `query()` with
  `RETURNING` whenever application correctness depends on the exact affected id.

## Testing

`npm run verify` checks that the plugin builds for the supported targets. The full
cross-platform behavioral suite is part of the playground app (`playground/`): build and
launch it on each target platform, then run the **Test Suite** tab.

## API

<docgen-index>

* [`getPlatform()`](#getplatform)
* [`isAvailable()`](#isavailable)
* [`open(...)`](#open)
* [`close(...)`](#close)
* [`isOpen(...)`](#isopen)
* [`getVersion(...)`](#getversion)
* [`getSchemaVersion(...)`](#getschemaversion)
* [`vacuum(...)`](#vacuum)
* [`execute(...)`](#execute)
* [`run(...)`](#run)
* [`runBatch(...)`](#runbatch)
* [`runMany(...)`](#runmany)
* [`query(...)`](#query)
* [`beginTransaction(...)`](#begintransaction)
* [`commitTransaction(...)`](#committransaction)
* [`rollbackTransaction(...)`](#rollbacktransaction)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

### getPlatform()

```typescript
getPlatform() => Promise<SqliteResult<{ platform: SqlitePlatform; }>>
```

Returns the platform identifier of the implementation answering calls.

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ platform: <a href="#sqliteplatform">SqlitePlatform</a>; }&gt;&gt;</code>

--------------------


### isAvailable()

```typescript
isAvailable() => Promise<SqliteResult<{ available: boolean; }>>
```

Returns `true` if SQLite is available on the current platform.

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ available: boolean; }&gt;&gt;</code>

--------------------


### open(...)

```typescript
open(options: OpenOptions) => Promise<SqliteResult>
```

Open (or create) a database. If `migrations` are supplied, pending
migrations are applied before the promise resolves.
Returns MIGRATION_FAILED if a migration entry
is malformed, versions are duplicated, or a migration statement fails.

| Param         | Type                                                |
| ------------- | --------------------------------------------------- |
| **`options`** | <code><a href="#openoptions">OpenOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;<a href="#record">Record</a>&lt;string, never&gt;&gt;&gt;</code>

--------------------


### close(...)

```typescript
close(options: { database: string; }) => Promise<SqliteResult>
```

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;<a href="#record">Record</a>&lt;string, never&gt;&gt;&gt;</code>

--------------------


### isOpen(...)

```typescript
isOpen(options: { database: string; }) => Promise<SqliteResult<{ open: boolean; }>>
```

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ open: boolean; }&gt;&gt;</code>

--------------------


### getVersion(...)

```typescript
getVersion(options: { database: string; }) => Promise<SqliteResult<{ version: string; }>>
```

Returns the SQLite engine version for the opened database connection.

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ version: string; }&gt;&gt;</code>

--------------------


### getSchemaVersion(...)

```typescript
getSchemaVersion(options: { database: string; }) => Promise<SqliteResult<{ version: number; }>>
```

Returns the current SQLite `PRAGMA user_version` for the opened database.

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ version: number; }&gt;&gt;</code>

--------------------


### vacuum(...)

```typescript
vacuum(options: { database: string; }) => Promise<SqliteResult>
```

Runs SQLite `VACUUM` for the opened database.

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;<a href="#record">Record</a>&lt;string, never&gt;&gt;&gt;</code>

--------------------


### execute(...)

```typescript
execute(options: ExecuteOptions) => Promise<SqliteResult<{ changes: number; }>>
```

Execute one or more SQL statements sequentially.
Use for DDL (`CREATE TABLE`, …) or bulk DML without params.
`statements` must be a non-empty array.
**Each array element must be a single SQL statement** — multiple semicolon-separated
statements in one string return a failure on every platform.
Statements run in a single transaction by default; pass
`transaction: false` to keep prior successful statements if a later one fails.
When called inside `beginTransaction()`, pass `transaction: false`;
nested transactions return TRANSACTION_FAILED.

| Param         | Type                                                      |
| ------------- | --------------------------------------------------------- |
| **`options`** | <code><a href="#executeoptions">ExecuteOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ changes: number; }&gt;&gt;</code>

--------------------


### run(...)

```typescript
run(options: RunOptions) => Promise<SqliteResult<{ changes: number; lastInsertId: number; }>>
```

Execute a single parameterized statement.
Returns the number of affected rows and the row ID inserted by this statement.
`lastInsertId` is `0` for UPDATE, DELETE, statements that insert no row,
and other non-INSERT/REPLACE statements.
`lastInsertId` is also `0` for any INSERT/REPLACE statement containing an
`ON CONFLICT` clause, since SQLite does not update the underlying rowid counter
when such a statement resolves via its `DO UPDATE` arm — use `query()` with a
`RETURNING` clause instead to get the affected row's id from an UPSERT.
It is conservatively `0` whenever SQLite's connection-level rowid counter
is unchanged (for example `WITHOUT ROWID`, replacement of the same explicit
rowid, or rowid reuse after deletion). Use `RETURNING` when the exact id is required.
Leading SQL comments and common `WITH ... INSERT` CTE forms are detected as inserts.
`lastInsertId` is a JavaScript number and is precise up to `Number.MAX_SAFE_INTEGER`.

For Web/OPFS, each successful autocommit write includes a browser durability
barrier. Use an explicit transaction, `runBatch()`, or `runMany()` for groups of
writes instead of issuing many individual autocommit `run()` calls.

| Param         | Type                                              |
| ------------- | ------------------------------------------------- |
| **`options`** | <code><a href="#runoptions">RunOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ changes: number; lastInsertId: number; }&gt;&gt;</code>

--------------------


### runBatch(...)

```typescript
runBatch(options: RunBatchOptions) => Promise<SqliteResult<{ changes: number; lastInsertId: number; }>>
```

Execute multiple parameterized statements in a single native call.
Use this for mixed-SQL bulk writes. For one repeated statement, prefer
`runMany()` because it transports and classifies the SQL text only once.
`lastInsertId` is always `0`; use `run()` when you need the inserted row ID.
When called inside `beginTransaction()`, pass `transaction: false`;
nested transactions return TRANSACTION_FAILED.

| Param         | Type                                                        |
| ------------- | ----------------------------------------------------------- |
| **`options`** | <code><a href="#runbatchoptions">RunBatchOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ changes: number; lastInsertId: number; }&gt;&gt;</code>

--------------------


### runMany(...)

```typescript
runMany(options: RunManyOptions) => Promise<SqliteResult<RunManyResult>>
```

Execute one parameterized statement for many value sets in one plugin call.
Unlike `runBatch()`, the SQL text is transported and classified only once.
Native and Electron backends retain one prepared statement for the loop;
sqlite-wasm Worker1 does not expose persistent statement handles, but still
benefits from the compact request shape. All value sets are validated before
the first write.

Prefer this over firing hundreds or thousands of concurrent `run()` calls for
bulk inserts. `Promise.all(run(...))` still creates one bridge request, native
queue entry, result object, and JavaScript callback per row; `runMany()` keeps
the same work in one public call. On Web/OPFS it also avoids repeating a durable
autocommit barrier for every row when `transaction` is left at its default.

The operation is atomic by default. Pass `transaction: false` to preserve
successful earlier executions if a later execution fails. `lastInsertId`
on the aggregate result is always `0`; opt into `returnResults` when each
execution's inserted row ID is required.

| Param         | Type                                                      |
| ------------- | --------------------------------------------------------- |
| **`options`** | <code><a href="#runmanyoptions">RunManyOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;<a href="#runmanyresult">RunManyResult</a>&gt;&gt;</code>

--------------------


### query(...)

```typescript
query<T = Record<string, unknown>>(options: QueryOptions) => Promise<SqliteResult<{ rows: T[]; }>>
```

Execute a result-producing statement and return rows as plain objects.
Supported forms are `SELECT`, `PRAGMA`, `EXPLAIN`, and
`INSERT`/`UPDATE`/`DELETE`/`REPLACE ... RETURNING`.
DML without `RETURNING` returns `INVALID_PARAMS`; use `run()` instead.
Use anonymous `?` placeholders with `values: [...]` for parameters.
Numbered and named placeholders are not guaranteed across platforms.
INTEGER result values outside JavaScript's safe integer range are returned
as strings rather than imprecise numbers.
Column names become object keys. Results are in `data.rows`.

| Param         | Type                                                  |
| ------------- | ----------------------------------------------------- |
| **`options`** | <code><a href="#queryoptions">QueryOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ rows: T[]; }&gt;&gt;</code>

--------------------


### beginTransaction(...)

```typescript
beginTransaction(options: { database: string; }) => Promise<SqliteResult>
```

Start a transaction. Returns TRANSACTION_FAILED if one is already active.

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;<a href="#record">Record</a>&lt;string, never&gt;&gt;&gt;</code>

--------------------


### commitTransaction(...)

```typescript
commitTransaction(options: { database: string; }) => Promise<SqliteResult>
```

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;<a href="#record">Record</a>&lt;string, never&gt;&gt;&gt;</code>

--------------------


### rollbackTransaction(...)

```typescript
rollbackTransaction(options: { database: string; }) => Promise<SqliteResult>
```

| Param         | Type                               |
| ------------- | ---------------------------------- |
| **`options`** | <code>{ database: string; }</code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;<a href="#record">Record</a>&lt;string, never&gt;&gt;&gt;</code>

--------------------


### Interfaces


#### SqliteSuccess

| Prop          | Type              |
| ------------- | ----------------- |
| **`success`** | <code>true</code> |
| **`data`**    | <code>T</code>    |


#### SqliteFailure

| Prop          | Type                                                |
| ------------- | --------------------------------------------------- |
| **`success`** | <code>false</code>                                  |
| **`error`**   | <code><a href="#sqliteerror">SqliteError</a></code> |


#### SqliteError

| Prop           | Type                                                             | Description                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`code`**     | <code><a href="#sqliteerrorcode">SqliteErrorCode</a></code>      |                                                                                                                                                                                   |
| **`message`**  | <code>string</code>                                              |                                                                                                                                                                                   |
| **`platform`** | <code><a href="#sqliteplatform">SqlitePlatform</a></code>        |                                                                                                                                                                                   |
| **`method`**   | <code>string</code>                                              |                                                                                                                                                                                   |
| **`details`**  | <code><a href="#record">Record</a>&lt;string, unknown&gt;</code> | Platform diagnostic metadata. All implementations include `nativeCode`, `nativeMessage`, and `source`; callers should treat additional keys as platform-specific debugging hints. |


#### OpenOptions

| Prop             | Type                                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`database`**   | <code>string</code>                                         | Database file name (without extension). On iOS and Electron, open database registry keys are matched case-insensitively to avoid two handles pointing at the same file on case-insensitive filesystems.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`readonly`**   | <code>boolean</code>                                        | When `true`, opens the database in read-only mode. Read operations are allowed, while write operations (`execute`, `run`, `runBatch`, `runMany`, `vacuum`, write transactions, and migrations) return a failure. Attempting to reopen an already-open database with a different `readonly` value or `directory` returns DB_ALREADY_OPEN.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **`directory`**  | <code><a href="#sqlitedirectory">SqliteDirectory</a></code> | Logical storage location for the database file. Raw filesystem paths are not accepted. - `default` / omitted: recommended persistent app storage - iOS: `Library/Application Support/CapacitorSQLite/` - Android: `&lt;filesDir&gt;/CapacitorSQLite/` - Electron: `app.getPath('userData')/CapacitorSQLite/` - Web: OPFS (`file:&lt;name&gt;.db?vfs=opfs`) - `documents`: user-document location where appropriate - iOS: `Documents/CapacitorSQLite/` - Android: app-specific external Documents if available, otherwise `&lt;filesDir&gt;/Documents/CapacitorSQLite/` - Electron: falls back to `userData` to avoid placing app databases in the user's Documents folder - Web: OPFS fallback - `library`: persistent app support data - iOS: `Library/Application Support/CapacitorSQLite/` - Android: `&lt;filesDir&gt;/CapacitorSQLite/` - Electron: `userData/CapacitorSQLite/` - Web: OPFS fallback - `cache`: rebuildable data only; the OS may delete it - iOS: `Library/Caches/CapacitorSQLite/` - Android: `&lt;cacheDir&gt;/CapacitorSQLite/` - Electron: `temp/capacitor-sqlite/CapacitorSQLite/` - Web: OPFS fallback `:memory:` databases ignore this option. |
| **`migrations`** | <code>Migration[]</code>                                    | When provided the plugin reads `PRAGMA user_version`, then runs every migration whose `version` is greater than the stored value, in order. After all migrations complete it writes the highest version back. Returns MIGRATION_FAILED if any entry is malformed, versions are duplicated, or a statement fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |


#### Migration

| Prop             | Type                  | Description                                                                                             |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| **`version`**    | <code>number</code>   | Target schema version. Must be unique within an `open()` call. Migrations run in ascending order.       |
| **`statements`** | <code>string[]</code> | SQL statements executed when upgrading to this version. Each string must contain exactly one statement. |


#### ExecuteOptions

| Prop              | Type                  | Description                                                                                                                    |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **`database`**    | <code>string</code>   |                                                                                                                                |
| **`statements`**  | <code>string[]</code> | One or more SQL statements (DDL or DML). No parameter binding. Must be a non-empty array — empty array returns INVALID_PARAMS. |
| **`transaction`** | <code>boolean</code>  | Wrap all statements in a single transaction. Default: `true`.                                                                  |


#### RunOptions

| Prop            | Type                                                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`database`**  | <code>string</code>                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **`statement`** | <code>string</code>                                   | Single parameterized SQL statement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **`values`**    | <code><a href="#sqlitevalues">SQLiteValues</a></code> | Positional values bound to anonymous `?` placeholders, in order. The value count must exactly match the placeholder count; `?` inside SQL strings, quoted identifiers, and comments is not counted. `number` values must be finite; integer `number` values must be within `Number.MAX_SAFE_INTEGER`. BLOB values should use <a href="#uint8array">`Uint8Array`</a>. Android/iOS transport them through a private tagged base64 envelope; Web/Electron retain the typed array. Numbered placeholders (`?1`) and named placeholders (`:name`, `@name`, `$name`) are not part of the cross-platform API contract. |


#### Uint8Array

A typed array of 8-bit unsigned integer values. The contents are initialized to 0. If the
requested number of bytes could not be allocated an exception is raised.

| Prop                    | Type                                                        | Description                                                                  |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **`BYTES_PER_ELEMENT`** | <code>number</code>                                         | The size in bytes of each element in the array.                              |
| **`buffer`**            | <code><a href="#arraybufferlike">ArrayBufferLike</a></code> | The <a href="#arraybuffer">ArrayBuffer</a> instance referenced by the array. |
| **`byteLength`**        | <code>number</code>                                         | The length in bytes of the array.                                            |
| **`byteOffset`**        | <code>number</code>                                         | The offset in bytes of the array.                                            |
| **`length`**            | <code>number</code>                                         | The length of the array.                                                     |

| Method             | Signature                                                                                                                                                                      | Description                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **copyWithin**     | (target: number, start: number, end?: number \| undefined) =&gt; this                                                                                                          | Returns the this object after copying a section of the array identified by start and end to the same array starting at position target                                                                                                      |
| **every**          | (predicate: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; unknown, thisArg?: any) =&gt; boolean                                            | Determines whether all the members of an array satisfy the specified test.                                                                                                                                                                  |
| **fill**           | (value: number, start?: number \| undefined, end?: number \| undefined) =&gt; this                                                                                             | Returns the this object after filling the section identified by start and end with value                                                                                                                                                    |
| **filter**         | (predicate: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; any, thisArg?: any) =&gt; <a href="#uint8array">Uint8Array</a>                   | Returns the elements of an array that meet the condition specified in a callback function.                                                                                                                                                  |
| **find**           | (predicate: (value: number, index: number, obj: <a href="#uint8array">Uint8Array</a>) =&gt; boolean, thisArg?: any) =&gt; number \| undefined                                  | Returns the value of the first element in the array where predicate is true, and undefined otherwise.                                                                                                                                       |
| **findIndex**      | (predicate: (value: number, index: number, obj: <a href="#uint8array">Uint8Array</a>) =&gt; boolean, thisArg?: any) =&gt; number                                               | Returns the index of the first element in the array where predicate is true, and -1 otherwise.                                                                                                                                              |
| **forEach**        | (callbackfn: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; void, thisArg?: any) =&gt; void                                                 | Performs the specified action for each element in an array.                                                                                                                                                                                 |
| **indexOf**        | (searchElement: number, fromIndex?: number \| undefined) =&gt; number                                                                                                          | Returns the index of the first occurrence of a value in an array.                                                                                                                                                                           |
| **join**           | (separator?: string \| undefined) =&gt; string                                                                                                                                 | Adds all the elements of an array separated by the specified separator string.                                                                                                                                                              |
| **lastIndexOf**    | (searchElement: number, fromIndex?: number \| undefined) =&gt; number                                                                                                          | Returns the index of the last occurrence of a value in an array.                                                                                                                                                                            |
| **map**            | (callbackfn: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number, thisArg?: any) =&gt; <a href="#uint8array">Uint8Array</a>               | Calls a defined callback function on each element of an array, and returns an array that contains the results.                                                                                                                              |
| **reduce**         | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number) =&gt; number                       | Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.                      |
| **reduce**         | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number, initialValue: number) =&gt; number |                                                                                                                                                                                                                                             |
| **reduce**         | &lt;U&gt;(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; U, initialValue: U) =&gt; U            | Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.                      |
| **reduceRight**    | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number) =&gt; number                       | Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function. |
| **reduceRight**    | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number, initialValue: number) =&gt; number |                                                                                                                                                                                                                                             |
| **reduceRight**    | &lt;U&gt;(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; U, initialValue: U) =&gt; U            | Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function. |
| **reverse**        | () =&gt; <a href="#uint8array">Uint8Array</a>                                                                                                                                  | Reverses the elements in an Array.                                                                                                                                                                                                          |
| **set**            | (array: <a href="#arraylike">ArrayLike</a>&lt;number&gt;, offset?: number \| undefined) =&gt; void                                                                             | Sets a value or an array of values.                                                                                                                                                                                                         |
| **slice**          | (start?: number \| undefined, end?: number \| undefined) =&gt; <a href="#uint8array">Uint8Array</a>                                                                            | Returns a section of an array.                                                                                                                                                                                                              |
| **some**           | (predicate: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; unknown, thisArg?: any) =&gt; boolean                                            | Determines whether the specified callback function returns true for any element of an array.                                                                                                                                                |
| **sort**           | (compareFn?: ((a: number, b: number) =&gt; number) \| undefined) =&gt; this                                                                                                    | Sorts an array.                                                                                                                                                                                                                             |
| **subarray**       | (begin?: number \| undefined, end?: number \| undefined) =&gt; <a href="#uint8array">Uint8Array</a>                                                                            | Gets a new <a href="#uint8array">Uint8Array</a> view of the <a href="#arraybuffer">ArrayBuffer</a> store for this array, referencing the elements at begin, inclusive, up to end, exclusive.                                                |
| **toLocaleString** | () =&gt; string                                                                                                                                                                | Converts a number to a string by using the current locale.                                                                                                                                                                                  |
| **toString**       | () =&gt; string                                                                                                                                                                | Returns a string representation of an array.                                                                                                                                                                                                |
| **valueOf**        | () =&gt; <a href="#uint8array">Uint8Array</a>                                                                                                                                  | Returns the primitive value of the specified object.                                                                                                                                                                                        |


#### ArrayLike

| Prop         | Type                |
| ------------ | ------------------- |
| **`length`** | <code>number</code> |


#### ArrayBufferTypes

Allowed <a href="#arraybuffer">ArrayBuffer</a> types for the buffer of an ArrayBufferView and related Typed Arrays.

| Prop              | Type                                                |
| ----------------- | --------------------------------------------------- |
| **`ArrayBuffer`** | <code><a href="#arraybuffer">ArrayBuffer</a></code> |


#### ArrayBuffer

Represents a raw buffer of binary data, which is used to store data for the
different typed arrays. ArrayBuffers cannot be read from or written to directly,
but can be passed to a typed array or DataView Object to interpret the raw
buffer as needed.

| Prop             | Type                | Description                                                                     |
| ---------------- | ------------------- | ------------------------------------------------------------------------------- |
| **`byteLength`** | <code>number</code> | Read-only. The length of the <a href="#arraybuffer">ArrayBuffer</a> (in bytes). |

| Method    | Signature                                                                               | Description                                                     |
| --------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **slice** | (begin: number, end?: number \| undefined) =&gt; <a href="#arraybuffer">ArrayBuffer</a> | Returns a section of an <a href="#arraybuffer">ArrayBuffer</a>. |


#### RunBatchOptions

| Prop              | Type                                                                                     | Description                                                   |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **`database`**    | <code>string</code>                                                                      |                                                               |
| **`set`**         | <code>{ statement: string; values?: <a href="#sqlitevalues">SQLiteValues</a>; }[]</code> |                                                               |
| **`transaction`** | <code>boolean</code>                                                                     | Wrap all statements in a single transaction. Default: `true`. |


#### RunManyResult

| Prop               | Type                             | Description                                                       |
| ------------------ | -------------------------------- | ----------------------------------------------------------------- |
| **`changes`**      | <code>number</code>              |                                                                   |
| **`lastInsertId`** | <code>0</code>                   | Aggregate operations do not have one unambiguous inserted row ID. |
| **`results`**      | <code>RunManyItemResult[]</code> | Present only when `returnResults: true`.                          |


#### RunManyItemResult

| Prop               | Type                |
| ------------------ | ------------------- |
| **`changes`**      | <code>number</code> |
| **`lastInsertId`** | <code>number</code> |


#### RunManyOptions

| Prop                | Type                        | Description                                                                                                                                     |
| ------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **`database`**      | <code>string</code>         |                                                                                                                                                 |
| **`statement`**     | <code>string</code>         | Single parameterized SQL statement reused for every values entry.                                                                               |
| **`values`**        | <code>SQLiteValues[]</code> | Non-empty list of positional value sets. Every inner array must exactly match the statement's anonymous `?` placeholders.                       |
| **`transaction`**   | <code>boolean</code>        | Wrap every execution in one transaction. Default: `true`.                                                                                       |
| **`returnResults`** | <code>boolean</code>        | Return `{changes, lastInsertId}` for every execution. Default: `false`. Leave disabled for maximum throughput and the smallest bridge response. |


#### QueryOptions

| Prop            | Type                                                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`database`**  | <code>string</code>                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **`statement`** | <code>string</code>                                   | Result-producing statement using anonymous `?` placeholders for bound values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`values`**    | <code><a href="#sqlitevalues">SQLiteValues</a></code> | Positional values bound to anonymous `?` placeholders, in order. The value count must exactly match the placeholder count; `?` inside SQL strings, quoted identifiers, and comments is not counted. `number` values must be finite; integer `number` values must be within `Number.MAX_SAFE_INTEGER`. BLOB values should use <a href="#uint8array">`Uint8Array`</a>. Android/iOS transport them through a private tagged base64 envelope; Web/Electron retain the typed array. On Android, `query()` uses a small SQL scanner before calling `rawQuery(String[])` so numeric, boolean, and BLOB values keep their SQLite types. The scanner ignores `?` inside strings, quoted identifiers, and SQL comments, and rejects unsupported numbered/named placeholder forms. |


### Type Aliases


#### SqliteResult

Every plugin method resolves to this type — never rejects.

<code><a href="#sqlitesuccess">SqliteSuccess</a>&lt;T&gt; | <a href="#sqlitefailure">SqliteFailure</a></code>


#### SqliteErrorCode

<code>'INVALID_PARAMS' | 'INVALID_NAME' | 'DB_NOT_OPEN' | 'DB_ALREADY_OPEN' | 'OPEN_FAILED' | 'CLOSE_FAILED' | 'EXECUTE_FAILED' | 'QUERY_FAILED' | 'VACUUM_FAILED' | 'VERSION_FAILED' | 'SCHEMA_VERSION_FAILED' | 'TRANSACTION_FAILED' | 'MIGRATION_FAILED' | 'NOT_AVAILABLE' | 'UNKNOWN'</code>


#### SqlitePlatform

<code>'ios' | 'android' | 'web' | 'electron'</code>


#### Record

Construct a type with a set of properties K of type T

<code>{ [P in K]: T; }</code>


#### SqliteDirectory

<code>'default' | 'documents' | 'library' | 'cache'</code>


#### SQLiteValues

<code>SQLiteValue[]</code>


#### SQLiteValue

<code>string | number | boolean | null | <a href="#uint8array">Uint8Array</a></code>


#### ArrayBufferLike

<code>ArrayBufferTypes[keyof ArrayBufferTypes]</code>

</docgen-api>
