# Testing

## Overview

|  | Count | Status |
|--|-------|--------|
| **Automated** | 341 tests · 70 groups | ✅ All passing on iOS · Android · Web · Electron |
| **Manual** | 11 scenarios | 🔲 Require OS-level control or native tooling |

Tests are part of the example app (`playground/`).  
Build and launch it on a target platform, open the **Test Suite** tab, and press **Run All**.  
Throughput and latency benchmarks run separately from the **Load Tests** tab (10 scenarios).

---

## Automated Tests

Tests that require a minimum SQLite version skip gracefully on older builds rather than failing.
Platform-specific quirks are documented in [Platform Notes](#platform-notes).

### Core API

| Group | IDs | Tests |
|-------|-----|-------|
| Platform | plat-01..02 | `getPlatform`, `isAvailable` |
| Lifecycle | lc-01..08 | open · close · isOpen · idempotence · persistence · re-open cycles |
| Execute | ex-01..06 | DDL/DML · rollback on error · `transaction:false` · nested transaction guard |
| Run | run-01..11 | INSERT/UPDATE/DELETE · `lastInsertId` · `changes` · UPSERT (graceful skip) |
| Query | q-01..15 | SELECT · params · types · JOINs · GROUP BY · HAVING · subqueries · CTE |
| RunBatch | rb-01..05 | batch insert · rollback · `transaction:false` · error cases |
| Transactions | tx-01..08 | begin/commit/rollback · nesting guard · visibility within txn |
| Migrations | mig-01..09 | v1 apply · sequential · idempotence · failure isolation · ordering |
| Metadata | gv-01..04 | `getVersion` · `vacuum` · `getSchemaVersion` |

### Data Types

| Group | IDs | Tests |
|-------|-----|-------|
| BLOB | blob-01..08 | `Uint8Array` round-trip · NULL · empty · full byte range · 50 KB |
| Numeric | num-01..05 | `MAX_SAFE_INTEGER` · float precision · zero · arithmetic functions |
| String | str-01..06 | empty · Unicode/emoji · SQL metacharacters · 10 KB · `\n`/`\t` · backslash |
| NULL Handling | null-01..08 | arithmetic · `IS NULL` · `COUNT` · UNIQUE NULLs · sort order · `NOT IN` gotcha |
| Boolean Policy | bool-01..04 | stored as INTEGER 1/0 · `TYPEOF` · round-trip · multiple params |
| Type Casting | cast-01..08 | `CAST` rules · integer vs real division · division by zero → NULL · type affinity |

### Schema & Constraints

| Group | IDs | Tests |
|-------|-----|-------|
| Schema | sch-01..07 | indexes · `table_info` · `DROP IF EXISTS` · FK · views · `ALTER ADD COLUMN` · `sqlite_master` |
| Constraints | con-01..04 | NOT NULL · UNIQUE · CHECK · PRIMARY KEY violations |
| Foreign Keys | fk-01..03 | orphan reject · `ON DELETE CASCADE` · `ON DELETE SET NULL` |
| FK ON UPDATE | fku-01..03 | `ON UPDATE CASCADE` · `ON UPDATE SET NULL` · `ON UPDATE RESTRICT` |
| Deferred FK | dfk-01..03 | COMMIT fails on violation · autocommit still enforces · child-before-parent ordering |
| Composite PK | cpk-01..03 | unique combos · duplicate rejection · partial-match allowed |
| Multi-column CHECK | mchk-01..02 | valid data passes · invalid data rejected |
| DEFAULT Values | def-01..04 | text/numeric/expression defaults · explicit NULL overrides DEFAULT |
| Partial Indexes | pidx-01..03 | `CREATE INDEX … WHERE` · unique within filter · duplicate outside filter |
| Expression Indexes | eidx-01..02 | `lower(col)` index creation · reflected in query plan |
| Index Advanced | idx-01..03 | UNIQUE index · composite index · `DROP INDEX` |

### SQL Features

| Group | IDs | Tests |
|-------|-----|-------|
| SQL Functions | fn-01..14 | COALESCE · NULLIF · IFNULL · CASE · string functions · LIKE/GLOB |
| Set Operations | set-01..04 | UNION · UNION ALL · INTERSECT · EXCEPT |
| EXISTS | exists-01..02 | `EXISTS` / `NOT EXISTS` subqueries |
| Triggers | trg-01..05 | AFTER INSERT · BEFORE DELETE · AFTER UPDATE · DROP TRIGGER · INSTEAD OF |
| Trigger Rollback | trrb-01..02 | BEFORE INSERT raises → no row · AFTER INSERT raises → rollback |
| Conflict Policies | conf-01..05 | OR IGNORE · OR REPLACE · OR ABORT · OR ROLLBACK · OR FAIL |
| Savepoints | svp-01..02 | `SAVEPOINT` + `RELEASE` · `ROLLBACK TO` partial rollback |
| Advanced Queries | adv-01..07 | self-join · CROSS JOIN · scalar subquery · correlated subquery · multiple CTE |
| View | view-01..02 | `CREATE VIEW` · `DROP VIEW` |
| Recursive CTE | rcte-01..03 | sequence · Fibonacci · tree traversal |
| Window Functions | wnd-01..03 | `ROW_NUMBER` · running SUM · `RANK` — graceful skip on SQLite < 3.25 |
| JSON Functions | json-01..03 | `json_extract` · `json()` validation · `json_array` — graceful skip |
| Identifier Quoting | iq-01..04 | reserved-word table/column names · spaces · Unicode — double-quoted |
| Quote Semantics | quote-01..02 | single-quote = string · double-quote = identifier · backtick extension |
| Column Names | colname-01..03 | space in name · reserved keyword · Unicode characters |
| Semicolons & Comments | mstmt-01..05 | trailing `;` · `--` inline · `/* */` block · multiple statements |

### PRAGMA & Configuration

| Group | IDs | Tests |
|-------|-----|-------|
| PRAGMA | prg-01..06 | `integrity_check` · `foreign_keys` · `table_info` · `index_list` · `page_count` · `cache_size` |
| WAL Mode | wal-01..04 | WAL journal mode · `synchronous` · `VACUUM` after bulk delete · `ANALYZE`/`REINDEX` |
| Collation | coll-01..05 | NOCASE equality · NOCASE ORDER BY · LIKE case rules · BINARY · emoji |
| Query Plan | plan-01..04 | full scan detection · index scan · covering index · JOIN plan |

### Modern SQLite

| Group | IDs | Tests |
|-------|-----|-------|
| WITHOUT ROWID | wrid-01..04 | basic CRUD · duplicate PK · UPDATE · `lastInsertId = 0` |
| FTS5 | fts-01..03 | virtual table · MATCH search · DELETE — graceful skip if unavailable |
| Generated Columns | gen-01..04 | VIRTUAL · STORED · indexed · write-reject — graceful skip on SQLite < 3.31 |
| STRICT Tables | strict-01..03 | type enforcement · DATATYPE error · `ANY` column — graceful skip on SQLite < 3.37 |
| RETURNING | ret-01..04 | INSERT/UPDATE/DELETE RETURNING via `query()` — graceful skip on SQLite < 3.35 |
| Column Alter | alter-01..02 | `RENAME COLUMN` (≥ 3.25) · `DROP COLUMN` (≥ 3.35) — graceful skip on older |

### Reliability

| Group | IDs | Tests |
|-------|-----|-------|
| Transaction Atomicity | txn-01..05 | mixed-API rollback · in-txn visibility · cross-DB isolation |
| Transaction State | txstate-01..02 | nested begin fails · commit without begin fails |
| lastInsertId | lid-01..05 | implicit rowid · explicit PK · UPDATE/DELETE return 0 · AUTOINCREMENT |
| Migration Extras | me-01..04 | version 0 skip · exact tracking · partial re-apply · failure isolation |
| Error Handling | err-01..05 | missing table · syntax error · constraint violations |
| Error Format | ef-01..04 | `{ success, error: { code, message } }` shape · `SCREAMING_SNAKE_CASE` codes |
| Invalid Params | ip-01..08 | empty SQL · unsupported types · `NaN`/`Infinity` → null · path traversal · long names |
| Result Shape | rs-01..05 | `query` always returns array · `run`/`runBatch` always return `{ changes, lastInsertId }` |
| Recovery | rec-01..05 | DB usable after run failure · rollback · syntax error · missing table · 3 consecutive errors |
| Concurrency | cc-01..05 | 10 parallel open · 10 parallel INSERT · 10 parallel query · rapid open/close · batch + query |
| Multi-DB | mdb-01..05 | two DBs simultaneously · `:memory:` lifecycle · cross-txn isolation · independent close |
| Readonly | ro-01..05 | write rejected · read allowed · `execute`/`vacuum` rejected · `getSchemaVersion` allowed |

### Scale & Real-world

| Group | IDs | Tests |
|-------|-----|-------|
| Large Data | ld-01..04 | 1 MB TEXT · 1 MB BLOB · 50-column row · `IN` with 200 params |
| Parameter Limits | param-01..03 | 999 params · 1001 params (no crash) · 256 KB text column |
| Boolean Policy | bool-01..04 | stored as 1/0 · `TYPEOF` = integer · round-trip as number |
| Compatibility Matrix | compat-01 | feature detection: JSON · FTS5 · Window · RETURNING · STRICT · WAL · Generated columns |
| Real-world Schema | rw-01..05 | 5-table e-commerce schema · FK joins · atomic order creation · `ON DELETE CASCADE` · rollback |
| Soak Tests | soak-01..03 | 50 open/insert/query/close cycles · 30 failing queries (stability) · 20× 50 KB BLOB insert/delete |

---

## Manual Testing

The following 11 scenarios cannot be covered by the JS test layer. They require OS-level interaction,
precise timing control, or native profiling tools.

| Scenario | Why it cannot be automated |
|----------|---------------------------|
| **Close during an operation** — `close()` races with an in-flight query, batch, or VACUUM | Requires OS-level timing; a guaranteed race condition cannot be constructed from JS |
| **App lifecycle** — background → foreground, activity recreation, iOS suspend/resume | Requires OS-level app lifecycle control |
| **Storage failures** — disk full, quota exceeded, locked file, missing data directory | Requires filesystem or OS environment manipulation |
| **Corrupted database** — deliberately damaged SQLite header or file | Requires direct access to the native file; unreachable from the JS layer |
| **Connection/memory leak measurement** — file descriptor growth, native heap growth over time | JS has no access to OS file descriptors or native heap profilers |
| **Web/WASM persistence edge cases** — IndexedDB deletion, private/incognito mode, reload without flush | Requires browser-level control beyond what JS tests can do |
| **Electron IPC security** — unauthorised channels, absolute paths, `ATTACH` outside the data directory | Requires platform-specific IPC layer testing |
| **iOS `NSURLIsExcludedFromBackupKey`** — backup exclusion attribute on the database file | Native iOS attribute; not accessible from JS |
| **Encryption** — SQLCipher or similar at-rest encryption | Plugin does not support encryption |
| **App suspend/resume with an open transaction** — transaction state across OS lifecycle events | OS lifecycle; JS cannot minimise or suspend the app |
| **Hot reload / JS context restart with a native DB open** — Capacitor live-reload edge cases | Requires Capacitor live-reload infrastructure |

---

## Platform Notes

| Observation | Platform | Covered by |
|-------------|----------|------------|
| Capacitor bridge encodes JS integers as Double-backed NSNumber | iOS | run-05 |
| `sqlite3_column_blob()` returns NULL for zero-length BLOBs | iOS | blob-03 |
| `:memory:` DB survives `close()` due to the connection pool | Android | mdb-02 (skip) |
| `compileStatement` does not support SELECT | Android | run-08 (skip) |
| `rawQuery(String[])` binds all values as TEXT — fixed by inlining numeric/boolean literals | Android | bool-02 |
| `node:sqlite` stores all JS numbers as REAL — fixed by using `BigInt` for integers | Electron | run-05 · bool-02 |
| Web WASM does not enforce readonly mode on write operations | Web | ro-01, ro-03, ro-04 (skip) |
| `NOT IN (…, NULL)` returns no rows — SQL NULL semantics | All | null-07 |
| Division by zero returns NULL (not an error) | All | cast-05 |
| Multiple NULLs in a UNIQUE column are allowed | All | null-05 |
| Window functions require SQLite ≥ 3.25 | All | wnd-01..03 |
| `WITHOUT ROWID` INSERT → `lastInsertId = 0` (no rowid exists) | All | wrid-04 |
| `true`/`false` stored as INTEGER 1/0, read back as `number` | All | bool-01..04 |
| Web WASM logs every SQLite constraint error to the browser console | Web | expected behaviour |
