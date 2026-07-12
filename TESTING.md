# Testing

## Overview

|               | Scope                                        | Purpose                                                                                 |
| ------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Automated** | 401 tests · 75 groups · 12 stress benchmarks · 24 diagnostics | Cross-platform behavioral, compatibility, and performance-regression coverage           |
| **Manual**    | 11 scenarios                                 | OS lifecycle, storage-failure, profiler, and native-environment checks outside JS reach |

Tests are part of the example app (`playground/`).  
Build and launch it on a target platform, open the **Test Suite** tab, and press **Run All**.  
Throughput and latency benchmarks run separately from the **Load Tests** tab: 12 original
full-load scenarios plus 24 shorter layer diagnostics.

The same test definitions (`playground/src/tests/suiteTests.ts`, `stressBenchmarks.ts`, and
`diagnosticBenchmarks.ts`) are
shared with a set of CLI runners — see [Running from the command line](#running-from-the-command-line)
— so the full suite can also be run outside the playground UI, without clicking through the app.

`npm run verify` checks that the plugin builds for the supported targets. The full
cross-platform behavioral suite above is run from the playground app on each target
platform, or from the CLI runners described below.

For release gating, record the date, commit, platform versions, target type
(simulator/emulator/device/browser/Electron), and command output for each full platform
run. A local verification may cover only a subset of the matrix, but release notes should
state which matrix entries were actually executed.

---

## Running from the command line

The 401 suite tests, 12 full-load benchmarks, and 24 layer diagnostics are defined once, in
`playground/src/tests/suiteTests.ts`, `playground/src/tests/stressBenchmarks.ts`, and
`playground/src/tests/diagnosticBenchmarks.ts`, as functions
that take a `CapacitorSqlitePlugin` implementation and return test/benchmark definitions. The
playground UI (`PageSuite.tsx` / `PageStress.tsx`) calls these with the real `CapacitorSqlite`
import; the CLI runners below call them with a platform backend directly, so it's the same test
code running either way, not a copy.

| Command                       | Platform                | How it connects                                                                                                                                                                                                      |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:suite:electron` | Electron (node:sqlite)  | Runs `ElectronSqliteBackend` in plain Node — no Electron process needed                                                                                                                                              |
| `npm run test:suite:web`      | Web (sqlite-wasm/OPFS)  | Starts the playground Vite dev server with COOP/COEP headers, launches Chrome/Chromium with a temporary profile, then drives the page over Chrome DevTools Protocol                                                  |
| `npm run test:suite:android`  | Android (Kotlin/SQLite) | Builds, installs and launches the playground on the currently running emulator/device, then drives its WebView over Chrome DevTools Protocol via `adb forward`                                                       |
| `npm run test:suite:ios`      | iOS (Swift/SQLite)      | Builds, installs and launches the playground on the currently booted Simulator, then drives its WKWebView over the WebKit Remote Web Inspector protocol (via `appium-remote-debugger`, without a full Appium server) |

Append `:stress` to any of the four (e.g. `npm run test:suite:android:stress`) to also run the
12 stress benchmarks after the suite. Append `:stress-only` to run only the benchmark profile
through the same non-UI driver. Each command exits non-zero if any test failed, so they're
usable as CI gates.

For timing-only reruns, prefer the `:stress-only` commands over clicking the **Load Tests**
page. They execute `window.__capSuite.runStress()` from the platform runner without rendering
the benchmark list or updating React state, which avoids measuring the playground UI and
Android WebView compositor/debugger scheduling as part of plugin throughput. The UI remains
useful as a manual end-to-end smoke path and to expose visible-page overhead.

Inside the playground app, the **Load Tests** page provides both visible buttons and quiet
buttons. The visible buttons keep the result list mounted and are useful for checking the
user-facing page behavior. The quiet buttons run the same benchmark definitions from inside the
app, but hide the result list and write React state only once at the end, giving a cleaner
in-app timing without switching to an external CLI runner.

```sh
npm run test:suite:web:stress-only
npm run test:suite:android:stress-only
npm run test:suite:ios:stress-only
npm run test:suite:electron:stress-only
```

Set `ANDROID_SERIAL` when multiple Android targets are connected.

Current stress benchmark sizes:

- `s-01`, `s-04`, `s-12`: 10,000 individually awaited end-to-end calls. These
  intentionally retain the original high load even on platforms where the run takes
  minutes; reducing the iteration count is not a performance improvement.
- `s-02`: 10,000 writes through one batch.
- `s-03`: 10,000 writes through one repeated-statement `runMany()` call.
- `s-05`: 10,000 simultaneously submitted writes; `s-06`: 5,000 writes plus
  5,000 reads.
- `s-07`, `s-08`: 100,000 inserted rows.
- `s-09`, `s-10`: 1 MB TEXT/BLOB round-trip.
- `s-11`: 2 open databases with 10,000 rows each.

### Performance layer diagnostics

Run only the shorter diagnostic profile with one of:

```sh
npm run test:suite:web:diagnostics
npm run test:suite:android:diagnostics
npm run test:suite:ios:diagnostics
npm run test:suite:electron:diagnostics
```

The **Load Tests** page also exposes **Run diagnostics (24)**. Use the UI for the
actual Electron end-to-end path: the Electron CLI runner instantiates
`ElectronSqliteBackend` directly and therefore excludes Electron IPC and the worker boundary.
Web, Android, and iOS CLI diagnostics run through their real browser/native bridge.

The diagnostics deliberately keep setup, seed, verification, and close operations outside
each reported interval. Sequential cases report average, p50, p95, p99, and min/max latency:

Interpret `s-05`, `s-06`, and `d-20..d-22` as bridge/queue fan-out measurements, not as
recommended bulk-write patterns. They intentionally submit thousands of individual
`run()`/`query()` calls so platform callback and queue-drain behavior is visible. Real bulk
imports should use `runMany()` for one repeated statement or `runBatch()` for mixed SQL.
On Web/OPFS, autocommit write fan-out also multiplies the browser's per-write durability
barrier; compare `d-20` with transactional `d-21` before treating a long web fan-out run
as SQLite or plugin overhead.
Similarly, `d-23`/`d-24` are query-planner checks: a large `WHERE + ORDER BY + LIMIT`
query without a matching index measures SQLite scan/sort work, not plugin transport.

| ID              | Timed path                                          | Primary comparison                                                           |
| --------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `d-01`          | Promise/timer harness only                          | Baseline to subtract from very fast JS-only cases                            |
| `d-02`          | 200 sequential `getPluginPlatform()` calls                | Small platform request/response without this plugin's SQLite queue           |
| `d-03`          | 200 sequential `isOpen()` calls                     | `d-03 − d-02`: plugin dispatch, queue, and registry lookup without SQL       |
| `d-04`          | 200 sequential `SELECT 1` calls                     | `d-04 − d-03`: minimal prepare/step plus one-row conversion                  |
| `d-05`          | 200 sequential `run()` calls inside one transaction | Write wrapper and metadata work without a durable commit per row             |
| `d-06`          | 200 sequential autocommit `run()` calls             | `d-06 − d-05`: framework transaction and storage commit contribution         |
| `d-07`          | 1,000 concurrent `getPluginPlatform()` calls              | Pipelined bridge throughput and completion-latency distribution              |
| `d-08`          | One recursive SQL statement creates 10,000 rows     | SQLite-heavy single-call reference with almost no per-row JS/bridge work     |
| `d-09`          | One `runBatch()` carries 10,000 items               | `d-09 − d-08`: payload, validation, binding loop, and batch wrapper cost     |
| `d-10` / `d-11` | 1 MB TEXT write / read                              | Separates input and output direction; compare platforms                      |
| `d-12` / `d-13` | 1 MB BLOB write / read                              | Measures tagged-base64 native transport versus Web/Electron structured clone |
| `d-14`          | Return 100,000 rows × 2 columns                     | SQLite scan plus row-object materialization and response transfer            |
| `d-15`          | One `runMany()` carries 10,000 value sets           | Compare with `d-09`: repeated SQL/object transport and parsing overhead      |
| `d-16`          | Reconstruct 100,000 JS objects from compact rows    | Pure JS allocation baseline for `d-14`                                       |
| `d-17`          | Encode a 1 MB native BLOB envelope                  | Pure JS tagged-base64 cost baseline for `d-12`                               |
| `d-18`          | JSON-serialize equivalent batch/many payloads       | Repeated SQL/object payload size and serialization reference                 |
| `d-19`          | Native `runBatch(10,000)` timing breakdown          | Android/iOS-only split for getArray, decode, queue, parse, prepare/prevalidate, reset, bind, step, commit |
| `d-20`          | 10,000 concurrent autocommit `run()` writes         | Full-load concurrent-write shape with wall time and completion latency       |
| `d-21`          | 10,000 concurrent `run()` writes in one transaction | `d-20 − d-21`: durable commit/autocommit cost under fan-out                  |
| `d-22`          | 5,000 concurrent writes + 5,000 concurrent reads    | Mixed workload split into separate write/read completion distributions       |
| `d-23`          | Filtered query without an index                     | Captures query plan and no-index WHERE+ORDER BY+LIMIT timing                 |
| `d-24`          | Filtered query with an index                        | Separates scan/sort planner cost from bridge and 100-row result overhead     |

The shared `rm-01..13` group covers aggregate and per-item results, generated IDs,
pre-write bind validation, atomic rollback, `transaction:false` partial persistence,
trigger changes, NULL/BLOB rebinding, closed/readonly handles, manual transactions,
conservative UPSERT IDs, and statements without placeholders.

These are controlled **end-to-end differential measurements**, not native profiler timestamps.
For example, `d-08` still includes one public call and one commit, while `d-10` includes both
transfer and SQLite binding/write. Interpret differences between paired cases and platforms;
do not claim that subtracting two noisy wall-clock values is an exact SQLite-core duration.
If a pair remains ambiguous, capture native traces/counters for the implicated path before
changing production code.

GitHub Actions:

- `.github/workflows/ci.yml` runs the fast CI path on pull requests and `main` pushes:
  lint/format checks, build, JS guard tests, Electron suite, and Web/OPFS suite.
- `.github/workflows/release-matrix.yml` is manually triggered before a release. It runs
  Electron, Web/OPFS, Android, and iOS as separate jobs, optionally including stress benchmarks,
  and uploads each platform log as a retained workflow artifact.

Prerequisites:

- **Electron**: none beyond Node 24+ (uses `node:sqlite`).
- **Web**: Chrome/Chromium available on PATH or via `CHROME_BIN`; the runner uses a temporary
  browser profile and requires OPFS + cross-origin isolation support.
- **Android**: an emulator or device already running and visible to `adb` (`$ANDROID_HOME/platform-tools/adb devices`).
  If more than one target is connected, set `ANDROID_SERIAL=<serial>`; the runner
  selects the WebView socket belonging to the playground PID and keeps USB-powered
  devices awake so another app's WebView or screen sleep cannot cause a false hang.
- **iOS**: a Simulator already booted (`xcrun simctl boot "iPhone 17 Pro"`), matching the
  destination name used in the `test:suite:ios:build` script.

---

## Automated Tests

Tests that require a minimum SQLite version skip explicitly on older builds rather than failing.
The runner records these as `skipped` with a reason; a capability/platform branch can no longer
return early and be counted as a pass. Release logs must report passed, skipped, and failed counts.
Platform-specific quirks are documented in [Platform Notes](#platform-notes).

### Core API

| Group        | IDs         | Tests                                                                                                                                             |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform     | plat-01..02 | `getPluginPlatform`, `isAvailable`                                                                                                                      |
| Lifecycle    | lc-01..08   | open · close · isOpen · idempotence · persistence · re-open cycles                                                                                |
| Execute      | ex-01..06   | DDL/DML · rollback on error · `transaction:false` · nested transaction guard                                                                      |
| Run          | run-01..12  | INSERT/UPDATE/DELETE/REPLACE · conservative `lastInsertId` · `changes` · UPSERT paths                                                             |
| Query        | q-01..17    | SELECT · params · types · JOINs · GROUP BY · HAVING · subqueries · CTE · DML-without-RETURNING rejection                                          |
| RunBatch     | rb-01..08   | batch insert · rollback · `transaction:false` · trigger changes · safe repeated-SQL rebind · `lastInsertId` stays 0                               |
| Transactions | tx-01..08   | begin/commit/rollback · nesting guard · visibility within txn                                                                                     |
| Migrations   | mig-01..13  | v1 apply · sequential · idempotence · failure isolation · ordering · partial commit · migration on live connection · active-transaction rejection |
| Metadata     | gv-01..05   | `getVersion` · `vacuum` · `getSchemaVersion` · `busy_timeout` set on every platform                                                               |
| Directory    | dir-01..03  | invalid enum · all logical directories · same DB/different directory guard                                                                        |

### Data Types

| Group          | IDs         | Tests                                                                                              |
| -------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| BLOB           | blob-01..08 | `Uint8Array` round-trip · NULL · empty · full byte range · 50 KB                                   |
| Numeric        | num-01..05  | `MAX_SAFE_INTEGER` · float precision · zero · arithmetic functions                                 |
| String         | str-01..07  | empty · Unicode/emoji · SQL metacharacters · 10 KB · `\n`/`\t` · backslash · transport-marker text |
| NULL Handling  | null-01..08 | arithmetic · `IS NULL` · `COUNT` · UNIQUE NULLs · sort order · `NOT IN` gotcha                     |
| Boolean Policy | bool-01..04 | stored as INTEGER 1/0 · `TYPEOF` · round-trip · multiple params                                    |
| Type Casting   | cast-01..08 | `CAST` rules · integer vs real division · division by zero → NULL · type affinity                  |

### Schema & Constraints

| Group              | IDs         | Tests                                                                                         |
| ------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| Schema             | sch-01..07  | indexes · `table_info` · `DROP IF EXISTS` · FK · views · `ALTER ADD COLUMN` · `sqlite_master` |
| Constraints        | con-01..04  | NOT NULL · UNIQUE · CHECK · PRIMARY KEY violations                                            |
| Foreign Keys       | fk-01..03   | orphan reject · `ON DELETE CASCADE` · `ON DELETE SET NULL`                                    |
| FK ON UPDATE       | fku-01..03  | `ON UPDATE CASCADE` · `ON UPDATE SET NULL` · `ON UPDATE RESTRICT`                             |
| Deferred FK        | dfk-01..03  | COMMIT fails on violation · autocommit still enforces · child-before-parent ordering          |
| Composite PK       | cpk-01..03  | unique combos · duplicate rejection · partial-match allowed                                   |
| Multi-column CHECK | mchk-01..02 | valid data passes · invalid data rejected                                                     |
| DEFAULT Values     | def-01..04  | text/numeric/expression defaults · explicit NULL overrides DEFAULT                            |
| Partial Indexes    | pidx-01..03 | `CREATE INDEX … WHERE` · unique within filter · duplicate outside filter                      |
| Expression Indexes | eidx-01..02 | `lower(col)` index creation · reflected in query plan                                         |
| Index Advanced     | idx-01..03  | UNIQUE index · composite index · `DROP INDEX`                                                 |

### SQL Features

| Group                 | IDs            | Tests                                                                                                                                                        |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL Functions         | fn-01..14      | COALESCE · NULLIF · IFNULL · CASE · string functions · LIKE/GLOB                                                                                             |
| Set Operations        | set-01..04     | UNION · UNION ALL · INTERSECT · EXCEPT                                                                                                                       |
| EXISTS                | exists-01..02  | `EXISTS` / `NOT EXISTS` subqueries                                                                                                                           |
| Triggers              | trg-01..09     | AFTER INSERT · BEFORE DELETE · AFTER UPDATE · DROP TRIGGER · INSTEAD OF · `CASE` body · `WHEN` clause · cascading triggers · begin/end/case-like identifiers |
| Trigger Rollback      | trrb-01..02    | BEFORE INSERT raises → no row · AFTER INSERT raises → rollback                                                                                               |
| Conflict Policies     | conf-01..05    | OR IGNORE · OR REPLACE · OR ABORT · OR ROLLBACK · OR FAIL                                                                                                    |
| Savepoints            | svp-01..02     | `SAVEPOINT` + `RELEASE` · `ROLLBACK TO` partial rollback                                                                                                     |
| Advanced Queries      | adv-01..07     | self-join · CROSS JOIN · scalar subquery · correlated subquery · multiple CTE                                                                                |
| View                  | view-01..02    | `CREATE VIEW` · `DROP VIEW`                                                                                                                                  |
| Recursive CTE         | rcte-01..03    | sequence · Fibonacci · tree traversal                                                                                                                        |
| Window Functions      | wnd-01..03     | `ROW_NUMBER` · running SUM · `RANK` — graceful skip on SQLite < 3.25                                                                                         |
| JSON Functions        | json-01..03    | `json_extract` · `json()` validation · `json_array` — graceful skip                                                                                          |
| Identifier Quoting    | iq-01..04      | reserved-word table/column names · spaces · Unicode — double-quoted                                                                                          |
| Quote Semantics       | quote-01..02   | single-quote = string · double-quote = identifier · backtick extension                                                                                       |
| Column Names          | colname-01..03 | space in name · reserved keyword · Unicode characters                                                                                                        |
| Semicolons & Comments | mstmt-01..06   | trailing `;` · `--` inline · `/* */` block · multiple statements · bare `begin` column doesn't mask a second statement                                       |
| Multi-Statement Guard | mstmt-07       | trigger containing qualified `NEW.end` remains one statement; genuine second statement is rejected                                                           |
| Query Placeholders    | qph-01..13     | anonymous `?` typing · comments · quoted identifiers · escaped strings · BLOBs · expressions · Android unsupported forms                                     |

### PRAGMA & Configuration

| Group      | IDs         | Tests                                                                                          |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------- |
| PRAGMA     | prg-01..06  | `integrity_check` · `foreign_keys` · `table_info` · `index_list` · `page_count` · `cache_size` |
| WAL Mode   | wal-01..04  | WAL journal mode · `synchronous` · `VACUUM` after bulk delete · `ANALYZE`/`REINDEX`            |
| Collation  | coll-01..05 | NOCASE equality · NOCASE ORDER BY · LIKE case rules · BINARY · emoji                           |
| Query Plan | plan-01..04 | full scan detection · index scan · covering index · JOIN plan                                  |

### Modern SQLite

| Group             | IDs           | Tests                                                                             |
| ----------------- | ------------- | --------------------------------------------------------------------------------- |
| WITHOUT ROWID     | wrid-01..04   | basic CRUD · duplicate PK · UPDATE · `lastInsertId = 0`                           |
| FTS5              | fts-01..03    | virtual table · MATCH search · DELETE — graceful skip if unavailable              |
| Generated Columns | gen-01..04    | VIRTUAL · STORED · indexed · write-reject — graceful skip on SQLite < 3.31        |
| STRICT Tables     | strict-01..03 | type enforcement · DATATYPE error · `ANY` column — graceful skip on SQLite < 3.37 |
| RETURNING         | ret-01..04    | INSERT/UPDATE/DELETE RETURNING via `query()` — graceful skip on SQLite < 3.35     |
| Column Alter      | alter-01..02  | `RENAME COLUMN` (≥ 3.25) · `DROP COLUMN` (≥ 3.35) — graceful skip on older        |

### Reliability

| Group                 | IDs            | Tests                                                                                                           |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Transaction Atomicity | txn-01..05     | mixed-API rollback · in-txn visibility · cross-DB isolation                                                     |
| Transaction State     | txstate-01..05 | nested/invalid boundaries · automatic state recovery after `OR ROLLBACK` through run/execute/runBatch           |
| lastInsertId          | lid-01..06     | implicit/explicit rowid · UPDATE/DELETE 0 · AUTOINCREMENT · conservative 0 when a deleted rowid is reused       |
| Migration Extras      | me-01..05      | version 0 skip · exact tracking · partial re-apply · failure isolation · version above 32-bit ceiling           |
| Error Handling        | err-01..05     | missing table · syntax error · constraint violations                                                            |
| Error Format          | ef-01..04      | `{ success, error: { code, message } }` shape · `SCREAMING_SNAKE_CASE` codes                                    |
| Invalid Params        | ip-01..08      | empty SQL · unsupported types · `NaN`/`Infinity` → null · path traversal · long names                           |
| Result Shape          | rs-01..05      | `query` always returns array · `run`/`runBatch` always return `{ changes, lastInsertId }`                       |
| Recovery              | rec-01..05     | DB usable after run failure · rollback · syntax error · missing table · 3 consecutive errors                    |
| Concurrency           | cc-01..05      | 10 parallel open · 10 parallel INSERT · 10 parallel query · rapid open/close · batch + query                    |
| Multi-DB              | mdb-01..05     | two DBs simultaneously · `:memory:` lifecycle · cross-txn isolation · independent close                         |
| Readonly              | ro-01..08      | write rejected · read allowed · mutation APIs rejected · Web `query_only` tampering cannot enable DML RETURNING |
| Bind Count            | bindcnt-01..04 | missing/extra values rejected for run/query; whole batch validated before any `transaction:false` write         |

### Scale & Real-world

| Group                | IDs          | Tests                                                                                             |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| Large Data           | ld-01..04    | 1 MB TEXT · 1 MB BLOB · 50-column row · `IN` with 200 params                                      |
| Parameter Limits     | param-01..03 | 999 params · 1001 params (no crash) · 256 KB text column                                          |
| Boolean Policy       | bool-01..04  | stored as 1/0 · `TYPEOF` = integer · round-trip as number                                         |
| Compatibility Matrix | compat-01    | feature detection: JSON · FTS5 · Window · RETURNING · STRICT · WAL · Generated columns            |
| Real-world Schema    | rw-01..05    | 5-table e-commerce schema · FK joins · atomic order creation · `ON DELETE CASCADE` · rollback     |
| Soak Tests           | soak-01..03  | 50 open/insert/query/close cycles · 30 failing queries (stability) · 20× 50 KB BLOB insert/delete |

---

## Regression Coverage Policy

Every production fix should add coverage at the lowest useful layer and, when practical,
through the shared end-to-end suite:

- parser or SQL-classification fixes should include unit tests for every maintained port
  plus at least one shared suite case that exercises the public API;
- platform-specific lifecycle, transaction, or bridge fixes should include native/unit
  coverage where available and an end-to-end regression when the behavior is observable
  from JavaScript;
- performance fixes should preserve the release-scale stress counts and, when the cause is
  not obvious, add or update a diagnostic benchmark that isolates the affected layer;
- capability-dependent SQLite features should skip explicitly with a reason rather than
  silently returning early or counting an unsupported path as passed.

Historical bug narratives belong in `CHANGELOG.md` or issue/PR discussions. This document
tracks the current test matrix, release procedure, and regression coverage expectations.

## Manual Testing

The following 11 scenarios cannot be covered by the JS test layer. They require OS-level interaction,
precise timing control, or native profiling tools.

| Scenario                                                                                               | Why it cannot be automated                                                          |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Close during an operation** — `close()` races with an in-flight query, batch, or VACUUM              | Requires OS-level timing; a guaranteed race condition cannot be constructed from JS |
| **App lifecycle** — background → foreground, activity recreation, iOS suspend/resume                   | Requires OS-level app lifecycle control                                             |
| **Storage failures** — disk full, quota exceeded, locked file, missing data directory                  | Requires filesystem or OS environment manipulation                                  |
| **Corrupted database** — deliberately damaged SQLite header or file                                    | Requires direct access to the native file; unreachable from the JS layer            |
| **Connection/memory leak measurement** — file descriptor growth, native heap growth over time          | JS has no access to OS file descriptors or native heap profilers                    |
| **Web/WASM persistence edge cases** — IndexedDB deletion, private/incognito mode, reload without flush | Requires browser-level control beyond what JS tests can do                          |
| **Electron IPC security** — unauthorised channels, absolute paths, `ATTACH` outside the data directory | Requires platform-specific IPC layer testing                                        |
| **iOS `NSURLIsExcludedFromBackupKey`** — backup exclusion attribute on the database file               | Native iOS attribute; not accessible from JS                                        |
| **Encryption** — SQLCipher or similar at-rest encryption                                               | Plugin does not support encryption                                                  |
| **App suspend/resume with an open transaction** — transaction state across OS lifecycle events         | OS lifecycle; JS cannot minimise or suspend the app                                 |
| **Hot reload / JS context restart with a native DB open** — Capacitor live-reload edge cases           | Requires Capacitor live-reload infrastructure                                       |

---

## Platform Notes

| Observation                                                                                                              | Platform                 | Covered by                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------ | -------------------------- |
| Capacitor bridge encodes JS integers as Double-backed NSNumber                                                           | iOS                      | run-05                     |
| `sqlite3_column_blob()` returns NULL for zero-length BLOBs                                                               | iOS                      | blob-03                    |
| `:memory:` DB survives `close()` due to the connection pool                                                              | Android                  | mdb-02 (skip)              |
| `compileStatement` does not support SELECT                                                                               | Android                  | run-08 (skip)              |
| `rawQuery(String[])` binds all values as TEXT; query binding preserves types by inlining safe typed literals              | Android                  | qph-01..13                 |
| `node:sqlite` stores JS numbers as REAL; integer semantics are preserved with `BigInt` where needed                       | Electron                 | run-05 · bool-02           |
| `directory` accepts logical locations only (`default`, `documents`, `library`, `cache`)                                  | All                      | manual review · extras tab |
| `cache` locations are not intended for cloud backup and may be purged by the OS                                          | iOS · Android · Electron | manual review              |
| `NOT IN (…, NULL)` returns no rows — SQL NULL semantics                                                                  | All                      | null-07                    |
| Division by zero returns NULL (not an error)                                                                             | All                      | cast-05                    |
| Multiple NULLs in a UNIQUE column are allowed                                                                            | All                      | null-05                    |
| Window functions require SQLite ≥ 3.25                                                                                   | All                      | wnd-01..03                 |
| `WITHOUT ROWID` INSERT → `lastInsertId = 0` (no rowid exists)                                                            | All                      | wrid-04                    |
| `true`/`false` stored as INTEGER 1/0, read back as `number`                                                              | All                      | bool-01..04                |
| Web WASM logs every SQLite constraint error to the browser console                                                       | Web                      | expected behaviour         |
