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
