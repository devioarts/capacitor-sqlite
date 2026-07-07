# Changelog

## 0.1.0 - 2026-07-06

Changes since `0.0.2`.

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

### Verified

- `npm run build`
- `npm run lint`
- `npm run verify:ios`
- `npm run verify:android`
- `npm run test:p0:js`
- `npm run test:p2:js`
- `npm run test:p0:ios`
- `npm run test:p0:android`
- `npm run test:suite:electron` - 365/365
- `npm run test:suite:web` - 365/365
- `npm run test:suite:android` - 365/365
- `npm run test:suite:ios` - 365/365
- `npm run test:suite:electron:stress` - 365/365 + 11 benchmarks
- `npm run test:suite:web:stress` - 365/365 + 11 benchmarks
- `npm run test:suite:android:stress` - 365/365 + 11 benchmarks
- `npm run test:suite:ios:stress` - 365/365 + 11 benchmarks
