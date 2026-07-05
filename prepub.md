# Pre-publication status

> Updated: 2026-07-05. This document replaces the older cross-platform review
> notes that listed issues which are now fixed.

## Fixed since the original review

- Migration entries are validated strictly and duplicate versions fail.
- Each SQL string must contain exactly one statement on every platform.
- `readonly: true` with migrations fails instead of silently skipping them.
- iOS numeric binding rejects unsafe integers instead of crashing.
- BLOB sentinel collisions are escaped through the `text64:` transport prefix.
- Unsafe SQLite INTEGER query results are returned as strings.
- Web/Electron `changes` use `total_changes()` diffs.
- Android multi-row INSERT `changes` now use `total_changes()` diffs.
- `WITH ... INSERT` and comment-prefixed INSERT statements are detected for `lastInsertId`.
- Electron has a busy timeout, safer close cleanup, and better open-time filesystem error codes.
- iOS/Android failed-open cleanup only removes the failed instance.
- Web `open()` participates in the per-database queue, and worker init timeouts terminate the worker.
- iOS/Electron open registries match database names case-insensitively to avoid duplicate handles on case-insensitive filesystems.
- Electron database work runs in a dedicated worker thread instead of Electron's main process.
- `SqliteError.details` now includes stable diagnostic fields: `nativeCode`, `nativeMessage`, and `source`.
- iOS and Android plugin wrappers dispatch database state checks through their async execution path.

## Remaining engineering work

- Replace native substring-based error-code mapping with typed internal error codes.
- Expand automated tests for error payload details on real native bridge calls.
- Add broader automated playground/app startup gates before manual playground testing.

## Release gate

Before publishing, run:

```shell
npm run test:p2
npm run verify
npm run lint
```

Then run the playground manually on the target platforms, especially Web OPFS and Electron.
