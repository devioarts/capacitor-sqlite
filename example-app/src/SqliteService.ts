/**
 * SqliteService — thin wrapper around @devioarts/capacitor-sqlite.
 *
 * Drop this file into your project and adjust `DB_NAME` and `MIGRATIONS`.
 * The service is a singleton; import the default export everywhere.
 */

import { CapacitorSqlite as CapacitorSQLite } from '@devioarts/capacitor-sqlite';
import type { Migration, SqliteResult, SQLiteValues } from '@devioarts/capacitor-sqlite';

// ─── configuration ────────────────────────────────────────────────────────────

const DB_NAME = 'myapp';

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
         id    INTEGER PRIMARY KEY AUTOINCREMENT,
         name  TEXT    NOT NULL,
         email TEXT
       )`,
    ],
  },
  // {
  //   version: 2,
  //   statements: ['ALTER TABLE users ADD COLUMN avatar TEXT'],
  // },
];

/** Regex for validating table and column names used in dynamically built queries. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${label} '${value}' contains invalid characters`);
  }
}

// ─── service ──────────────────────────────────────────────────────────────────

class SqliteService {
  private openPromise: Promise<void> | null = null;
  private isOpened = false;
  private debug = false;

  setDebug(enabled: boolean) {
    this.debug = enabled;
  }

  // ── init ──────────────────────────────────────────────────────────────────

  /** Opens the database once, applies pending migrations. Subsequent calls are no-ops. */
  async init(): Promise<void> {
    if (this.isOpened) return;
    if (!this.openPromise) {
      this.openPromise = CapacitorSQLite.open({
        database: DB_NAME,
        migrations: MIGRATIONS,
      }).then((result) => {
        if (!result.success) {
          throw new Error(result.error.message);
        }
        this.isOpened = true;
        if (this.debug) console.debug('[SQLite] opened:', DB_NAME);
      }).catch((err) => {
        // Clear the cached promise so callers can retry after a transient failure.
        this.openPromise = null;
        throw err;
      });
    }
    return this.openPromise;
  }

  private async ready(): Promise<boolean> {
    try {
      await this.init();
      return true;
    } catch (err) {
      console.error('[SQLite] init failed:', err);
      return false;
    }
  }

  // ── query ─────────────────────────────────────────────────────────────────

  /**
   * SELECT query — returns typed rows.
   * Pass values as additional arguments or as a single array.
   *
   * @example
   * const { data } = await db.query<User>('SELECT * FROM users WHERE id = ?', 1);
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<{ error: boolean; data: T[]; message: string }> {
    if (!(await this.ready())) return { error: true, data: [], message: 'Database is not ready' };

    const values = flattenParams(params);
    if (this.debug) console.debug('[SQLite][query]', sanitizeForLog(sql, values));

    const result = await CapacitorSQLite.query<T>({
      database: DB_NAME,
      statement: sql,
      values: values as SQLiteValues,
    });

    if (!result.success) {
      console.error('[SQLite][query]', sql, result.error.message);
      return { error: true, data: [], message: result.error.message };
    }
    return { error: false, data: result.data.rows ?? [], message: 'OK' };
  }

  // ── run ───────────────────────────────────────────────────────────────────

  /**
   * Single parameterized DML statement (INSERT / UPDATE / DELETE).
   *
   * @example
   * const { changes, lastInsertId } = await db.run('INSERT INTO users (name) VALUES (?)', 'Alice');
   */
  async run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ error: boolean; changes: number; lastInsertId: number; message: string }> {
    if (!(await this.ready())) return { error: true, changes: 0, lastInsertId: 0, message: 'Database is not ready' };

    const values = flattenParams(params);
    if (this.debug) console.debug('[SQLite][run]', sanitizeForLog(sql, values));

    const result = await CapacitorSQLite.run({
      database: DB_NAME,
      statement: sql,
      values: values as SQLiteValues,
    });

    if (!result.success) {
      console.error('[SQLite][run]', result.error.message);
      return { error: true, changes: 0, lastInsertId: 0, message: result.error.message };
    }
    return { error: false, changes: result.data.changes, lastInsertId: result.data.lastInsertId, message: 'OK' };
  }

  // ── exec ──────────────────────────────────────────────────────────────────

  /**
   * Execute one or more DDL statements. No parameter binding.
   *
   * @example
   * await db.exec('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, msg TEXT)');
   */
  async exec(
    statements: string | string[],
  ): Promise<{ error: boolean; changes: number; message: string }> {
    if (!(await this.ready())) return { error: true, changes: 0, message: 'Database is not ready' };

    const stmts = Array.isArray(statements) ? statements : [statements];
    if (this.debug) console.debug('[SQLite][exec]', stmts.join(';\n'));

    const result = await CapacitorSQLite.execute({ database: DB_NAME, statements: stmts });

    if (!result.success) {
      console.error('[SQLite][exec]', result.error.message);
      return { error: true, changes: 0, message: result.error.message };
    }
    return { error: false, changes: result.data.changes, message: 'OK' };
  }

  // ── runBatch ──────────────────────────────────────────────────────────────

  /**
   * Execute multiple parameterized statements in one native call.
   */
  async runBatch(
    set: { statement: string; values?: unknown[] }[],
    useTransaction = true,
  ): Promise<{ error: boolean; changes: number; lastInsertId: number; message: string }> {
    if (!(await this.ready())) return { error: true, changes: 0, lastInsertId: 0, message: 'Database is not ready' };
    if (!set.length) return { error: true, changes: 0, lastInsertId: 0, message: 'Empty batch' };

    const result = await CapacitorSQLite.runBatch({
      database: DB_NAME,
      set: set as { statement: string; values?: SQLiteValues }[],
      transaction: useTransaction,
    });

    if (!result.success) {
      console.error('[SQLite][runBatch]', result.error.message);
      return { error: true, changes: 0, lastInsertId: 0, message: result.error.message };
    }
    return { error: false, changes: result.data.changes, lastInsertId: result.data.lastInsertId, message: 'OK' };
  }

  // ── convenience helpers ───────────────────────────────────────────────────

  /**
   * Insert a row from a plain object.
   * Table and column names are validated against a safe-identifier regex.
   *
   * @example
   * const { insertId } = await db.insert('users', { name: 'Dave', email: 'dave@example.com' });
   */
  async insert(
    table: string,
    data: Record<string, unknown>,
  ): Promise<{ error: boolean; insertId: number | null; message: string }> {
    validateIdentifier(table, 'table');
    const cols = Object.keys(data);
    cols.forEach((c) => validateIdentifier(c, 'column'));

    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(data);
    const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;

    const result = await this.run(sql, values);
    return {
      error: result.error,
      insertId: result.error ? null : result.lastInsertId,
      message: result.message,
    };
  }

  /**
   * Update rows from a plain object.
   * `whereClause` must use `?` placeholders; pass values separately as `whereValues`.
   * Table and column names are validated against a safe-identifier regex.
   *
   * @example
   * await db.update('users', { email: 'new@example.com' }, 'id = ?', [1]);
   */
  async update(
    table: string,
    data: Record<string, unknown>,
    whereClause: string,
    whereValues: SQLiteValues = [],
  ): Promise<{ error: boolean; rowsAffected: number; message: string }> {
    if (!Object.keys(data).length) return { error: true, rowsAffected: 0, message: 'No data provided' };
    validateIdentifier(table, 'table');
    const cols = Object.keys(data);
    cols.forEach((c) => validateIdentifier(c, 'column'));

    const setClause = cols.map((c) => `"${c}" = ?`).join(', ');
    const values: unknown[] = [...Object.values(data), ...whereValues];
    // whereClause must contain only ? placeholders (no values) — enforced by type and documentation.
    const sql = `UPDATE "${table}" SET ${setClause} WHERE ${whereClause}`;

    const result = await this.run(sql, values);
    return {
      error: result.error,
      rowsAffected: result.changes,
      message: result.message,
    };
  }

  /**
   * Returns the first row matching the WHERE clause, or `null` if not found.
   * `where` must use `?` placeholders; pass values separately as `whereValues`.
   * Table name is validated against a safe-identifier regex.
   *
   * @example
   * const { data } = await db.getRow<User>('users', 'id = ?', [1]);
   */
  async getRow<T extends Record<string, unknown> = Record<string, unknown>>(
    table: string,
    where: string,
    whereValues: SQLiteValues = [],
  ): Promise<{ error: boolean; data: T | null; message: string }> {
    validateIdentifier(table, 'table');
    const sql = `SELECT * FROM "${table}" WHERE ${where} LIMIT 1`;
    const result = await this.query<T>(sql, whereValues);
    return {
      error: result.error,
      data: result.data[0] ?? null,
      message: result.message,
    };
  }

  /**
   * Returns a single field value as a string, or `null` if not found.
   * `where` must use `?` placeholders; pass values separately as `whereValues`.
   * Table and field names are validated against a safe-identifier regex.
   *
   * @example
   * const { value } = await db.getField('users', 'email', 'id = ?', [1]);
   */
  async getField(
    table: string,
    field: string,
    where: string,
    whereValues: SQLiteValues = [],
  ): Promise<{ error: boolean; value: string | null; message: string }> {
    validateIdentifier(table, 'table');
    validateIdentifier(field, 'field');
    const sql = `SELECT "${field}" FROM "${table}" WHERE ${where} LIMIT 1`;
    const result = await this.query<Record<string, unknown>>(sql, whereValues);
    if (result.error) return { error: true, value: null, message: result.message };

    const row = result.data[0];
    if (!row || row[field] == null) return { error: false, value: null, message: 'Not found' };
    return { error: false, value: String(row[field]), message: 'OK' };
  }

  // ── transactions ──────────────────────────────────────────────────────────

  /**
   * Run `fn` inside a transaction. Commits on success, rolls back on error.
   *
   * @example
   * await db.transaction(async () => {
   *   await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', 100, 1);
   *   await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', 100, 2);
   * });
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const begin = await CapacitorSQLite.beginTransaction({ database: DB_NAME });
    if (!begin.success) throw new Error(begin.error.message);
    try {
      const result = await fn();
      const commit = await CapacitorSQLite.commitTransaction({ database: DB_NAME });
      if (!commit.success) throw new Error(commit.error.message);
      return result;
    } catch (err) {
      await CapacitorSQLite.rollbackTransaction({ database: DB_NAME }).catch(() => undefined);
      throw err;
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (!this.isOpened) return;
    await CapacitorSQLite.close({ database: DB_NAME });
    this.isOpened = false;
    this.openPromise = null;
  }

  async resetDatabase(): Promise<{ error: boolean; message: string }> {
    try {
      if (!(await this.ready())) throw new Error('Database is not ready');

      await CapacitorSQLite.execute({
        database: DB_NAME,
        statements: ['PRAGMA foreign_keys = OFF'],
        transaction: false,
      });

      const { data: objects } = await this.query<{ type: string; name: string }>(`
        SELECT type, name FROM sqlite_master
        WHERE type IN ('view', 'trigger', 'table') AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'view' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END
      `);

      const allowedTypes = new Set(['table', 'view', 'trigger']);
      const drops = objects
        .filter((r) => allowedTypes.has(r.type))
        .map((r) => `DROP ${r.type.toUpperCase()} IF EXISTS "${r.name.replace(/"/g, '""')}"`);
      if (drops.length) {
        await CapacitorSQLite.execute({ database: DB_NAME, statements: drops });
      }

      await CapacitorSQLite.execute({ database: DB_NAME, statements: ['PRAGMA user_version = 0'] });
      await CapacitorSQLite.execute({
        database: DB_NAME,
        statements: ['PRAGMA foreign_keys = ON'],
        transaction: false,
      });

      await this.close();

      return { error: false, message: 'Database reset successfully' };
    } catch (err) {
      console.error('[SQLite][resetDatabase]', err);
      return { error: true, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalises rest params: if the caller passed a single array as the first arg,
 * unwrap it; otherwise use the params as-is.
 * Both `db.run(sql, [1, 2])` and `db.run(sql, 1, 2)` produce `[1, 2]`.
 */
function flattenParams(params: unknown[]): unknown[] {
  if (params.length === 1 && Array.isArray(params[0])) return params[0] as unknown[];
  return params;
}

/**
 * Produces a debug-only log string. Values are replaced with `?` placeholders
 * so sensitive data never appears in logs — the plain SQL template is shown.
 */
function sanitizeForLog(sql: string, params: unknown[]): string {
  return `${sql} [${params.map(() => '?').join(', ')}]`;
}

// Kept for type usage in SqliteService — re-export so consumers don't need a separate import.
export type { SqliteResult };

// ─── singleton ────────────────────────────────────────────────────────────────

const db = new SqliteService();
export default db;
