export interface MigrationVersion {
  version: number;
}

// SQLite's `PRAGMA user_version` is stored in a 32-bit signed field in the database
// header, and Android's Kotlin `Int` is 32-bit too, so this is a real ceiling shared by
// every backend — not an arbitrary choice. Values above this were previously accepted by
// the Web/Electron validators and then silently truncated when written to
// `PRAGMA user_version`, which could make a migration re-apply on a later `open()` call
// without any error being surfaced.
export const MAX_MIGRATION_VERSION = 2147483647;

export function isValidMigrationVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_MIGRATION_VERSION;
}

export interface DuplicateMigrationVersion {
  version: number;
  index: number;
}

export function findDuplicateMigrationVersion(
  migrations: readonly MigrationVersion[],
): DuplicateMigrationVersion | null {
  const seen = new Set<number>();
  for (let index = 0; index < migrations.length; index++) {
    const version = migrations[index].version;
    if (seen.has(version)) return { version, index };
    seen.add(version);
  }
  return null;
}
