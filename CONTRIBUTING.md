# Contributing

Thanks for helping improve `@devioarts/capacitor-sqlite`.

This plugin targets four backends: iOS, Android, Web/OPFS, and Electron. Please keep changes
small, cross-platform where possible, and covered by the shared playground suite when behavior
changes.

## Local Setup

1. Fork and clone the repo.
1. Install root dependencies.

   ```shell
   npm ci
   ```

1. Install playground dependencies if you will run Web, Android, or iOS suite tests.

   ```shell
   npm ci --prefix playground
   ```

1. On macOS, make sure Xcode command line tools and Swift tooling are available. Android work
   requires a working Android SDK and an emulator/device visible to `adb`.

## Common Commands

### `npm run build`

Builds the plugin, regenerates API docs with `@capacitor/docgen`, compiles TypeScript, bundles
the Web plugin, and builds the Electron entry points.

### `npm run lint`

Runs ESLint, Prettier, and SwiftLint. SwiftLint should report 0 violations before review.

### `npm run test:p2`

Runs the lightweight regression gate: JS SQL guard tests, iOS XCTest, Android unit tests,
Web/Electron builds, and migration validation tests.

### Full Suite

The shared behavioral suite currently has 366 tests and 11 stress benchmarks. The same test
definitions are used by the playground UI and the CLI runners.

```shell
npm run test:suite:electron
npm run test:suite:web
npm run test:suite:android
npm run test:suite:ios
```

Append `:stress` to also run the stress benchmarks:

```shell
npm run test:suite:web:stress
```

See [TESTING.md](TESTING.md#running-from-the-command-line) for platform prerequisites and
details on how each runner connects to the real backend.

## GitHub Actions

- `CI` runs automatically on pull requests and pushes to `main`. It covers lint/format checks,
  build, JS guard tests, Electron suite, and Web/OPFS suite.
- `Release Matrix` is manually triggered before a release. It runs Electron, Web/OPFS, Android,
  and iOS as separate jobs, optionally including stress benchmarks, and uploads platform logs as
  workflow artifacts.

## Pull Requests

Before opening a PR:

- Run the smallest relevant local test first.
- Run `npm run lint`.
- Update `README.md`, `TESTING.md`, or `CHANGELOG.md` when behavior, commands, or release-visible
  behavior changes.
- Include platform notes when a change affects only one backend.
- Avoid committing generated package tarballs (`*.tgz`) or local build artifacts.

## Publishing

Publishing is done from the package root:

```shell
npm run release
```

The `prepublishOnly` hook runs `npm run build` before publishing. The `files` array in
`package.json` controls what is included in the npm package; verify with:

```shell
npm pack --dry-run
```
