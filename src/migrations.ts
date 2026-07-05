export interface MigrationVersion {
  version: number;
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
