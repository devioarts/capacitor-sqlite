# Changelog

## [0.1.1] - 2026-07-12

### Added

- Added the cross-platform `runMany()` API for one SQL statement and many value sets. It validates every set before the first write, is atomic by default, reuses one prepared statement on Android/iOS/Electron, uses a compact single-SQL request on sqlite-wasm Worker1, returns only aggregate changes by default, and optionally returns per-item changes/row IDs. Existing APIs are unchanged.
- Added `runMany(10,000)` to the full-load stress profile next to `runBatch(10,000)`, so the repeated-statement transport gain is visible in normal and quiet in-app benchmark runs instead of only in layer diagnostics.
- Added shared `rm-01..13`, iOS native `RunManyTests`, an Electron worker regression, and diagnostics `d-15..24`: runMany versus runBatch, pure JS row reconstruction, native BLOB envelope encoding, equivalent payload serialization, Android/iOS native `runBatch` timing breakdown, concurrent-write fan-out, mixed read/write fan-out, and filtered-query plan comparisons.
- Expanded regression coverage for bind counts, UPSERT row IDs, query planning, migrations, busy timeout, Electron worker lifecycle, compact query transport, and Android device-reported failures.
- Added a separate 24-case performance-diagnostic profile (`d-01..d-24`) with latency percentiles and controlled comparisons for JS harness cost, platform dispatch, plugin queue/registry, minimal SQL, transactional versus autocommit writes, concurrent bridge throughput, SQLite-heavy single-call work, batch/runMany wrapping, TEXT/BLOB input and output, large-result materialization, pure-JS stage baselines, detailed native Android/iOS batch breakdown, concurrent write/mixed workload breakdowns, and filtered-query plan comparisons. The original full-load profile remains separate and unchanged.

### Changed

- Removed leftover Capacitor-plugin-generator boilerplate test stubs (`android/src/test/kotlin/com/getcapacitor/ExampleUnitTest.kt`, `android/src/androidTest/kotlin/com/getcapacitor/android/ExampleInstrumentedTest.kt`) — dead code, never published in the npm package, no functional effect.
- Excluded `dist/docs.json` (docgen intermediate artifact, no runtime purpose) from the published npm package.
- Added `electron` as an optional peer dependency (`peerDependenciesMeta.electron.optional: true`) so npm can report a version mismatch when Electron is present without warning pure iOS/Android/Web consumers who never install it.
- README: corrected the "iOS multi-database scheduling" caveat to state explicitly that Android shares the identical single-thread/single-queue limitation across all open databases (previously only called out for iOS); documented that a multi-version `migrations` list is not atomic as a whole (a later version's failure leaves earlier versions durably committed); documented the new UPSERT `lastInsertId` behavior; documented `CapacitorSqlite.dispose()` for Electron.
- `src/definitions.ts` JSDoc for `run()` updated to document the UPSERT `lastInsertId: 0` behavior (source of the generated README API section).
- Transaction documentation now checks every resolved `SqliteResult` instead of relying on `try`/`catch`; plugin SQL failures resolve with `success: false` and do not reject Promises.
- Documentation now describes the shared underlying executor/worker scheduling accurately and specifies live-connection migration, exact anonymous-bind-count, ambiguous-rowid behavior, known bulk-write/fan-out limitations, Web/OPFS autocommit durability cost, mixed read/write serialization, and the need for application indexes on large filtered/sorted queries.

### Fixed

- **Cross-platform SQL validation is now consistent.** `run()`, `query()`, `runBatch()`, and `runMany()` reject missing/extra bind values, unsupported placeholders, malformed multi-statement SQL, non-finite native numbers, and relevant invalid-parameter cases with the expected public error codes.
- **Transaction and lifecycle state is more reliable.** Reopening an already-open database applies pending migrations consistently, invalid manual-transaction migration attempts are rejected, `OR ROLLBACK` resynchronizes mirrored state, Web readonly connections reassert `query_only`, Android teardown no longer blocks/drops queued calls, and iOS close/open registry races are guarded.
- **`lastInsertId` is now conservative and portable.** UPSERT update paths, `WITHOUT ROWID` tables, unchanged connection rowids, replacement of the same explicit key, and rowid reuse return `0`; use `RETURNING` when the exact affected row ID is required. iOS also uses the 64-bit total-changes counter where available.
- **Web parity gaps were closed.** Web now enforces the already-open `directory` contract, sets `busy_timeout`, mirrors connection-local rowid state to avoid extra successful `run()` worker round-trips, and resynchronizes that mirror after errors.
- **Binary and result transport no longer do unnecessary object expansion.** Android/iOS use a private tagged-base64 BLOB envelope, Electron keeps `Uint8Array` through structured clone, and Android/iOS/Electron renderer queries use compact column/value transport before reconstructing the public row-object shape in JavaScript.
- **Bulk write paths avoid duplicated native work.** Transactional `runBatch()` reuses prepared statements for repeated SQL, validates the full input before the first write, avoids duplicate bind/metadata passes, and keeps `transaction:false` semantics unchanged. Repeated SQL analysis now uses bounded caches.
- **Packaging and generated-output issues were fixed.** The published package includes `android/proguard-rules.pro`, generated ESM output is importable by plain Node ESM consumers, and Electron's `runMany()` metadata/compatibility path is covered.
- **Benchmark and suite reliability improved.** Capability skips are explicit, runners report skip counts, Android CDP attaches to the intended WebView, stress tests validate API results and large payload contents, and the full-load matrix keeps its original release-scale counts.

## [0.1.0] - 2026-07-06

### Added

- Added a real Web/OPFS CLI suite runner: `npm run test:suite:web` and `npm run test:suite:web:stress`.
- Added Web runner validation for cross-origin isolation and OPFS availability before executing the suite.
- Added shared suite regression coverage for `query()` rejecting DML without `RETURNING`.
- Added JS parser tests for result-producing SQL accepted by `query()`.
- Added explicit SQL trust-boundary documentation.
- Added native lifecycle cleanup for open database handles on Android and iOS.
- Expanded `TESTING.md` release-test guidance.
- Added cross-platform stress benchmark results for Electron, Web/OPFS, Android, and iOS.
- Added GitHub Actions workflows for fast CI and a manually triggered release matrix with retained platform logs.
- Added regression tests for the migration-version-bound and BLOB-clamping fixes below: `isValidMigrationVersion` boundary cases in `test/migration-validation.test.cjs` (shared by Web and Electron), new iOS XCTest cases, and `me-05` in the shared suite.
- Added regression tests for the bare-identifier statement-splitting fix below: new cases in `test/sql-guard.test.cjs` and `SqlStatementGuardTest.kt`, a new `SQLStatementGuardTests.swift` (iOS previously had no direct unit test for this scanner), and `mstmt-06` in the shared suite.

### Changed

- `query()` now only accepts result-producing SQL: `SELECT`, `PRAGMA`, `EXPLAIN`, and `INSERT`/`UPDATE`/`DELETE`/`REPLACE ... RETURNING`.
- Android SQLite work now runs on a single executor thread to preserve transaction thread affinity.
- Android CDP suite runner now starts long-running tests in the WebView and polls for completion instead of holding one long `Runtime.evaluate` call open.
- Stress benchmarks now use release-relevant sizes: 10,000 writes, 100,000-row reads, 1 MB large values, and 2 x 10,000-row multi-DB load.
- Stress runner timeouts were raised for larger release-scale benchmark runs.
- README API documentation was regenerated and updated for the corrected `query()` contract.
- iOS Swift implementation was split into smaller helper files for maintainability.
- iOS unit tests were split by concern to keep test files easier to audit.
- `TESTING.md` now documents all four suite runners: Electron, Web, Android, and iOS.

### Fixed

- Fixed `query()` allowing write DML without result rows on some backends.
- Fixed Android manual transactions hanging when `beginTransaction()` and later statements ran on different executor threads.
- Fixed Android executor resource risk from unbounded cached thread creation.
- Fixed Android/iOS plugin teardown leaving open database handles until process cleanup.
- Fixed SwiftLint maintenance warnings; lint now reports 0 violations.
- Fixed Web runtime coverage gap by running the shared suite in a real browser against sqlite-wasm/OPFS.
- Fixed migration `version` accepting values above the 32-bit `user_version` ceiling on Web, Electron, and iOS — Web/Electron silently truncated an out-of-range version via a `| 0` cast when writing `PRAGMA user_version`, which could make a migration re-apply on a later `open()` without any error being surfaced; iOS had no upper bound at all. All four platforms now reject `version > 2147483647` up front with `MIGRATION_FAILED`.
- Fixed iOS BLOB bind values passed as a plain byte array (`number[]`) silently clamping an out-of-range byte instead of rejecting it, matching the existing Android and Electron behavior.
- Fixed the single-statement guard (`hasMultipleSqlStatements`/`hasMultipleStatements`, all three ports) misreading a bare `begin` or `case` identifier (e.g. a column named `begin` — SQLite does not reserve either word) as a trigger-body keyword, which swallowed the following semicolon and let `execute()` silently run a second statement it should have rejected. Found via automated code review.
- Fixed `npm run test:suite:web` hanging indefinitely on CI (GitHub Actions `ubuntu-latest`) after the suite finished and printed its result. Chrome was launched without `--headless`, which relies on a display server that CI runners don't have; even after adding `--headless=new`, an orphaned Chrome helper process could still hold an inherited stdio pipe open and keep the script's Node process alive. Fixed by launching Chrome/npm detached (their own process group), killing the whole group on cleanup instead of just the direct child, and forcing an explicit `process.exit()` as a safety net.
