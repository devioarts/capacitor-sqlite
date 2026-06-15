# @devioarts/capacitor-sqlite

> **Early release** — This plugin is new and has not been battle-tested in production. Please evaluate it thoroughly before shipping. Bug reports, edge-case findings, and general feedback are very welcome — open an issue or reach out directly.

SQLite plugin for Capacitor — iOS, Android, Web (OPFS), and Electron.

- Schema migrations via `PRAGMA user_version` — each version runs in its own transaction
- Thread-safe concurrent queries (serial `DispatchQueue` on iOS, `ReentrantLock` on Android)
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

Check `isAvailable()` at startup — `':memory:'` databases still work on web even when OPFS is unavailable.

### Electron

Uses Node's built-in `node:sqlite` module. Electron must expose `node:sqlite` at runtime; call `isAvailable()` to detect unsupported Electron/Node versions. Register the plugin in your Electron main process:

```ts
// electron/src/index.ts
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite/electron';

// Wire into Capacitor's Electron bridge or expose via IPC as needed.
// Databases are stored in: app.getPath('userData')/CapacitorSQLite/<name>.db
```

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

| Platform | Default path |
| -------- | ------------ |
| iOS | `<Library/Application Support>/CapacitorSQLite/<name>.db` |
| Android | `<filesDir>/CapacitorSQLite/<name>.db` |
| Web | OPFS — `file:<name>.db?vfs=opfs` (origin-scoped, no custom path support) |
| Electron | `app.getPath('userData')/CapacitorSQLite/<name>.db` |

The directory is created automatically if it does not exist.

Use the `directory` option to choose one of the supported logical locations. Raw absolute
or relative filesystem paths are not accepted.

```ts
await CapacitorSqlite.open({
  database: 'myapp',
  directory: 'library',
});
```

| `directory` | iOS | Android | Web | Electron | Backup expectation |
| ------------ | --- | ------- | --- | -------- | ------------------ |
| omitted / `default` | `Library/Application Support/CapacitorSQLite/<name>.db` | `<filesDir>/CapacitorSQLite/<name>.db` | OPFS `file:<name>.db?vfs=opfs` | `userData/CapacitorSQLite/<name>.db` | Backed up on iOS and Android by default; Electron `userData` may be cloud-backed by the OS/user environment |
| `library` | `Library/Application Support/CapacitorSQLite/<name>.db` | `<filesDir>/CapacitorSQLite/<name>.db` | OPFS fallback | `userData/CapacitorSQLite/<name>.db` | Same as `default`; recommended for persistent app databases |
| `documents` | `Documents/CapacitorSQLite/<name>.db` | app-specific external Documents if available, otherwise `<filesDir>/Documents/CapacitorSQLite/<name>.db` | OPFS fallback | Falls back to `userData/CapacitorSQLite/<name>.db` | Backed up on iOS/Android by default; use only for user-document/export-style data |
| `cache` | `Library/Caches/CapacitorSQLite/<name>.db` | `<cacheDir>/CapacitorSQLite/<name>.db` | OPFS fallback | `temp/capacitor-sqlite/CapacitorSQLite/<name>.db` | Not intended for cloud backup; OS may delete cache data |

> **Web:** all directory values use OPFS because browsers do not expose native app
> directory paths to the plugin.

> **Electron:** `documents` intentionally falls back to `userData` so an app database
> is not placed directly in the user's visible Documents folder.

> **`:memory:`:** the `directory` option is ignored for in-memory databases.

## Migrations

`open()` reads `PRAGMA user_version`, then runs every migration whose `version` exceeds the stored value (ascending order). Each migration runs in its own transaction — if it fails the transaction is rolled back and `open()` returns a failure result. Migrations already applied on previous launches are skipped automatically.

Calling `open()` again for an already-open database is idempotent only when the `readonly` mode matches the existing connection. Reopening the same database with a different `readonly` value returns `DB_ALREADY_OPEN`.

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

## Transactions

```ts
await CapacitorSqlite.beginTransaction({ database: 'myapp' });
try {
  await CapacitorSqlite.run({ database: 'myapp', statement: 'UPDATE ...', values: [...] });
  await CapacitorSqlite.runBatch({ database: 'myapp', set: [...], transaction: false });
  await CapacitorSqlite.commitTransaction({ database: 'myapp' });
} catch (e) {
  await CapacitorSqlite.rollbackTransaction({ database: 'myapp' });
  throw e;
}
```

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

In-memory databases are not persisted. They are destroyed when `close()` is called or the process exits.

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
typed arrays natively, verify your BLOB round-trip on each target platform before relying
on it in production.

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
are valid SQLite syntax, but they are not part of this plugin's cross-platform API
contract. The plugin exposes positional arrays, not named bind objects.

On Android, `query()` has to use `SQLiteDatabase.rawQuery(sql, String[])`, which
only accepts string bind arguments. To preserve SQLite types, the plugin scans SQL
before `rawQuery()` and safely inlines numeric, boolean, and BLOB values as SQL
literals. The scanner ignores `?` inside string literals, quoted identifiers, and
SQL comments, and rejects unsupported numbered/named placeholder forms.

## Platform notes

|              | iOS                        | Android                   | Web                                   | Electron                  |
| ------------ | -------------------------- | ------------------------- | ------------------------------------- | ------------------------- |
| Storage path | Application Support/CapacitorSQLite/ | filesDir/CapacitorSQLite/ | OPFS                                  | userData/CapacitorSQLite/ |
| WAL mode     | ✓                          | ✓                         | Not supported by sqlite-wasm          | ✓                         |
| `:memory:`   | ✓                          | ✓                         | ✓                                     | ✓                         |
| Min version  | iOS 15                     | API 24                    | Chrome 86 / Firefox 111 / Safari 15.2 | Electron 32 (Node 24)     |

### Cross-platform caveats

A few behaviours differ between platforms. None block normal use, but they matter for
correctness-sensitive code:

- **One statement per `execute()` entry.** Each element of `statements[]` should be a
  single SQL statement. Multiple statements packed into one string (`"INSERT …; INSERT …"`)
  run fully only on iOS and Web; on Android and Electron only the first statement executes.
- **`run()` `changes` for multi-row inserts on Android.** A single `INSERT` that adds
  several rows (`VALUES (..),(..)` or `INSERT … SELECT`) reports `changes: 1` on Android,
  while iOS/Web/Electron report the real row count. `lastInsertId` is correct everywhere.
- **Android `query()` placeholder scanning.** Android's `rawQuery()` accepts only
  string bind args, so the plugin scans SQL and inlines numeric, boolean, and BLOB
  `?` values as SQL literals to preserve types. Use only anonymous `?`
  placeholders; numbered/named placeholders are intentionally not supported.
- **Call ordering.** On iOS/Android/Electron, concurrent un-awaited calls to the same
  database are serialized for safety but not guaranteed to run in call order. Always `await`
  each call before issuing the next — especially around `beginTransaction` /
  `commitTransaction`. (The web implementation additionally enforces FIFO ordering per
  database.)

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
is malformed or a migration statement fails.

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
statements in one string work on iOS/Web but fail on Android/Electron.
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
`lastInsertId` is a JavaScript number and is precise up to `Number.MAX_SAFE_INTEGER`.
**Android caveat:** a multi-value `INSERT INTO t VALUES (…),(…)` always reports
`changes = 1` regardless of the number of inserted rows; other platforms report
the real count. Single-row inserts are correct on all platforms.

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
`lastInsertId` is always `0`; use `run()` when you need the inserted row ID.
**Android caveat:** a multi-value `INSERT INTO t VALUES (…),(…)` always reports
`changes = 1` regardless of the number of inserted rows; other platforms report
the real count.
When called inside `beginTransaction()`, pass `transaction: false`;
nested transactions return TRANSACTION_FAILED.

| Param         | Type                                                        |
| ------------- | ----------------------------------------------------------- |
| **`options`** | <code><a href="#runbatchoptions">RunBatchOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#sqliteresult">SqliteResult</a>&lt;{ changes: number; lastInsertId: number; }&gt;&gt;</code>

--------------------


### query(...)

```typescript
query<T = Record<string, unknown>>(options: QueryOptions) => Promise<SqliteResult<{ rows: T[]; }>>
```

Execute a `SELECT` statement and return rows as plain objects.
Use anonymous `?` placeholders with `values: [...]` for parameters.
Numbered and named placeholders are not guaranteed across platforms.
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

| Prop           | Type                                                             |
| -------------- | ---------------------------------------------------------------- |
| **`code`**     | <code><a href="#sqliteerrorcode">SqliteErrorCode</a></code>      |
| **`message`**  | <code>string</code>                                              |
| **`platform`** | <code><a href="#sqliteplatform">SqlitePlatform</a></code>        |
| **`method`**   | <code>string</code>                                              |
| **`details`**  | <code><a href="#record">Record</a>&lt;string, unknown&gt;</code> |


#### OpenOptions

| Prop             | Type                                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`database`**   | <code>string</code>                                         | Database file name (without extension).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`readonly`**   | <code>boolean</code>                                        | When `true`, opens the database in read-only mode. Read operations are allowed, while write operations (`execute`, `run`, `runBatch`, `vacuum`, write transactions, and migrations) return a failure. Attempting to reopen an already-open database with a different `readonly` value returns DB_ALREADY_OPEN.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **`directory`**  | <code><a href="#sqlitedirectory">SqliteDirectory</a></code> | Logical storage location for the database file. Raw filesystem paths are not accepted. - `default` / omitted: recommended persistent app storage - iOS: `Library/Application Support/CapacitorSQLite/` - Android: `&lt;filesDir&gt;/CapacitorSQLite/` - Electron: `app.getPath('userData')/CapacitorSQLite/` - Web: OPFS (`file:&lt;name&gt;.db?vfs=opfs`) - `documents`: user-document location where appropriate - iOS: `Documents/CapacitorSQLite/` - Android: app-specific external Documents if available, otherwise `&lt;filesDir&gt;/Documents/CapacitorSQLite/` - Electron: falls back to `userData` to avoid placing app databases in the user's Documents folder - Web: OPFS fallback - `library`: persistent app support data - iOS: `Library/Application Support/CapacitorSQLite/` - Android: `&lt;filesDir&gt;/CapacitorSQLite/` - Electron: `userData/CapacitorSQLite/` - Web: OPFS fallback - `cache`: rebuildable data only; the OS may delete it - iOS: `Library/Caches/CapacitorSQLite/` - Android: `&lt;cacheDir&gt;/CapacitorSQLite/` - Electron: `temp/capacitor-sqlite/CapacitorSQLite/` - Web: OPFS fallback `:memory:` databases ignore this option. |
| **`migrations`** | <code>Migration[]</code>                                    | When provided the plugin reads `PRAGMA user_version`, then runs every migration whose `version` is greater than the stored value, in order. After all migrations complete it writes the highest version back. Returns MIGRATION_FAILED if any entry is malformed or a statement fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |


#### Migration

| Prop             | Type                  | Description                                               |
| ---------------- | --------------------- | --------------------------------------------------------- |
| **`version`**    | <code>number</code>   | Target schema version. Migrations run in ascending order. |
| **`statements`** | <code>string[]</code> | SQL statements executed when upgrading to this version.   |


#### ExecuteOptions

| Prop              | Type                  | Description                                                                                                                    |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **`database`**    | <code>string</code>   |                                                                                                                                |
| **`statements`**  | <code>string[]</code> | One or more SQL statements (DDL or DML). No parameter binding. Must be a non-empty array — empty array returns INVALID_PARAMS. |
| **`transaction`** | <code>boolean</code>  | Wrap all statements in a single transaction. Default: `true`.                                                                  |


#### RunOptions

| Prop            | Type                                                  | Description                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`database`**  | <code>string</code>                                   |                                                                                                                                                                                                   |
| **`statement`** | <code>string</code>                                   | Single parameterized SQL statement.                                                                                                                                                               |
| **`values`**    | <code><a href="#sqlitevalues">SQLiteValues</a></code> | Positional values bound to anonymous `?` placeholders, in order. Numbered placeholders (`?1`) and named placeholders (`:name`, `@name`, `$name`) are not part of the cross-platform API contract. |


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


#### QueryOptions

| Prop            | Type                                                  | Description                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`database`**  | <code>string</code>                                   |                                                                                                                                                                                                                                                                                                                                                           |
| **`statement`** | <code>string</code>                                   | `SELECT` statement using anonymous `?` placeholders for bound values.                                                                                                                                                                                                                                                                                     |
| **`values`**    | <code><a href="#sqlitevalues">SQLiteValues</a></code> | Positional values bound to anonymous `?` placeholders, in order. On Android, `query()` uses a small SQL scanner before calling `rawQuery(String[])` so numeric, boolean, and BLOB values keep their SQLite types. The scanner ignores `?` inside strings, quoted identifiers, and SQL comments, and rejects unsupported numbered/named placeholder forms. |


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
