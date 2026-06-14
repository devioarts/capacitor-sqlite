import React, { useState } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import type { Migration } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';

const DB = 'migration_demo';
const SCOPE = 'mig';

const V1: Migration[] = [
  {
    version: 1,
    statements: [
      'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
    ],
  },
];

const V1_V2: Migration[] = [
  ...V1,
  {
    version: 2,
    statements: [
      'ALTER TABLE users ADD COLUMN email TEXT',
      'CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT)',
    ],
  },
];

const V1_V3: Migration[] = [
  ...V1_V2,
  {
    version: 3,
    statements: [
      'ALTER TABLE posts ADD COLUMN body TEXT',
      'CREATE INDEX idx_posts_user ON posts(user_id)',
    ],
  },
];

const BAD_SQL: Migration[] = [
  ...V1,
  {
    version: 2,
    statements: [
      'THIS IS NOT SQL',
    ],
  },
];

const MISSING_VERSION: Migration[] = [
  {
    version: 1,
    statements: ['CREATE TABLE foo (id INTEGER PRIMARY KEY)'],
  },
  {
    version: 3,  // skips version 2
    statements: ['CREATE TABLE bar (id INTEGER PRIMARY KEY)'],
  },
];

export const PageMigration: React.FC = () => {
  const log = useLogger();
  const [isOpen, setIsOpen] = useState(false);
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);

  const closeDb = async () => {
    await CapacitorSqlite.close({ database: DB }).catch(() => undefined);
    setIsOpen(false);
    setSchemaVersion(null);
  };

  const readVersion = async () => {
    const r = await CapacitorSqlite.getSchemaVersion({ database: DB });
    if (r.success) {
      setSchemaVersion(r.data.version);
      log.info(SCOPE, `getSchemaVersion() → ${r.data.version}`);
    } else log.error(SCOPE, 'getSchemaVersion failed', r.error);
  };

  const openWithMigrations = async (migrations: Migration[], label: string) => {
    await closeDb();
    const r = await CapacitorSqlite.open({ database: DB, migrations });
    if (r.success) {
      log.info(SCOPE, `open(${label}) → OK ✓`);
      setIsOpen(true);
      await readVersion();
    } else {
      log.error(SCOPE, `open(${label}) failed`, r.error);
    }
  };

  const migrateV1 = () => openWithMigrations(V1, 'v1 migrations');

  const migrateV1V2 = () => openWithMigrations(V1_V2, 'v1+v2 migrations');

  const migrateV1V3 = () => openWithMigrations(V1_V3, 'v1+v2+v3 migrations');

  const idempotentReopen = async () => {
    if (!isOpen) {
      log.warn(SCOPE, 'Open with V1 first');
      return;
    }
    const r = await CapacitorSqlite.open({ database: DB, migrations: V1 });
    if (r.success) {
      log.info(SCOPE, 'Re-open with same migrations → idempotent ✓');
      await readVersion();
    } else {
      log.error(SCOPE, 'Re-open failed', r.error);
    }
  };

  const migrateIncrementalV2 = async () => {
    if (!isOpen) {
      log.warn(SCOPE, 'Open with V1 first, then click this button');
      return;
    }
    await closeDb();
    const r = await CapacitorSqlite.open({ database: DB, migrations: V1_V2 });
    if (r.success) {
      log.info(SCOPE, 'Incremental V1→V2 migration ✓');
      setIsOpen(true);
      await readVersion();
    } else {
      log.error(SCOPE, 'V1→V2 migration failed', r.error);
    }
  };

  const badSqlMigration = async () => {
    await closeDb();
    const r = await CapacitorSqlite.open({ database: DB, migrations: BAD_SQL });
    if (!r.success)
      log.info(SCOPE, `Bad SQL migration → error (${r.error.code}) ✓`, r.error.message);
    else {
      log.error(SCOPE, 'Expected failure, DB opened with bad SQL migration');
      setIsOpen(true);
    }
  };

  const missingVersionMigration = async () => {
    await closeDb();
    const r = await CapacitorSqlite.open({ database: DB, migrations: MISSING_VERSION });
    if (!r.success)
      log.info(SCOPE, `Missing version migration → error (${r.error.code}) ✓`, r.error.message);
    else {
      log.warn(SCOPE, 'Missing version (1→3) was accepted — plugin may allow gaps');
      setIsOpen(true);
      await readVersion();
    }
  };

  const inspectSchema = async () => {
    const tables = await CapacitorSqlite.query({
      database: DB,
      statement: "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
    });
    if (tables.success) log.info(SCOPE, 'Schema tables', tables.data.rows);
    else log.error(SCOPE, 'inspect failed', tables.error);

    const indexes = await CapacitorSqlite.query({
      database: DB,
      statement: "SELECT name, tbl_name FROM sqlite_master WHERE type='index' ORDER BY name",
    });
    if (indexes.success) log.info(SCOPE, 'Schema indexes', indexes.data.rows);
  };

  const downgradeAttempt = async () => {
    if (!isOpen) {
      log.warn(SCOPE, 'Open with V2+ first');
      return;
    }
    const cur = schemaVersion ?? 0;
    if (cur < 2) {
      log.warn(SCOPE, 'Need at least V2 open to attempt downgrade test');
      return;
    }
    await closeDb();
    const r = await CapacitorSqlite.open({ database: DB, migrations: V1 });
    if (!r.success)
      log.info(SCOPE, `Downgrade attempt → error (${r.error.code}) ✓`, r.error.message);
    else {
      log.warn(SCOPE, 'Downgrade was accepted (plugin may allow it)', r.data);
      setIsOpen(true);
      await readVersion();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button onClick={closeDb} type="red">
          Close DB
        </Button>
        {isOpen && <span className="text-xs text-emerald-700 font-semibold">● DB open</span>}
        {schemaVersion !== null && (
          <span className="text-xs bg-indigo-100 text-indigo-700 rounded px-2 py-0.5">
            schema v{schemaVersion}
          </span>
        )}
        {isOpen && <Button onClick={inspectSchema}>Inspect schema</Button>}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Open with migrations</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="green" onClick={migrateV1}>Open with V1</Button>
          <Button type="green" onClick={migrateV1V2}>Open with V1+V2</Button>
          <Button type="green" onClick={migrateV1V3}>Open with V1+V2+V3</Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Incremental migration</h3>
        <div className="flex flex-wrap gap-2">
          <Button onClick={idempotentReopen} disabled={!isOpen}>
            Re-open same migrations (idempotent)
          </Button>
          <Button onClick={migrateIncrementalV2} disabled={!isOpen}>
            Re-open V1→V2 (incremental)
          </Button>
          <Button type="yellow" onClick={downgradeAttempt} disabled={!isOpen}>
            Downgrade attempt (V2→V1)
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Error cases</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="yellow" onClick={badSqlMigration}>Bad SQL migration</Button>
          <Button type="yellow" onClick={missingVersionMigration}>Missing version (1→3 gap)</Button>
        </div>
      </div>
    </div>
  );
};
