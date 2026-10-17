const SQL_CACHE_LIMIT = 256;

function cached<T>(cache: Map<string, T>, sql: string, compute: () => T): T {
  const hit = cache.get(sql);
  if (hit !== undefined || cache.has(sql)) {
    // Refresh insertion order so frequently repeated application statements stay hot.
    cache.delete(sql);
    cache.set(sql, hit as T);
    return hit as T;
  }
  const value = compute();
  cache.set(sql, value);
  if (cache.size > SQL_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return value;
}

const multipleStatementCache = new Map<string, boolean>();
const statementTypeCache = new Map<string, string>();
const conflictCache = new Map<string, boolean>();
const rollbackConflictCache = new Map<string, boolean>();
const bindParameterCache = new Map<string, { count: number; error?: string }>();

export function hasMultipleSqlStatements(sql: string): boolean {
  return cached(multipleStatementCache, sql, () => computeHasMultipleSqlStatements(sql));
}

function computeHasMultipleSqlStatements(sql: string): boolean {
  // A trigger ends at `; END;`. BEGIN/END elsewhere can be ordinary identifiers.
  let header = 0;
  let trigger = false;
  let afterSemicolon = false;
  let triggerEnd = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    let token = '';
    if (/\s/.test(ch)) continue;
    if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === '[') {
      i = skipBracketIdentifier(sql, i);
    } else if (ch === ';') {
      if (!trigger || triggerEnd) return hasTailContent(sql, i + 1);
      afterSemicolon = true;
      triggerEnd = false;
      continue;
    } else if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const keyword = readKeyword(sql, i)!;
      token = keyword.keyword;
      i = keyword.end - 1;
    }
    if (header === 0 && token === 'EXPLAIN') {
      header = 3;
    } else if (header === 3 && token === 'QUERY') {
      header = 4;
    } else if (header === 4 && token === 'PLAN') {
      header = 5;
    } else if ((header === 0 || header === 3 || header === 5) && token === 'CREATE') {
      header = 1;
    } else if (header === 1 && (token === 'TEMP' || token === 'TEMPORARY')) {
      header = 2;
    } else {
      if ((header === 1 || header === 2) && token === 'TRIGGER') trigger = true;
      header = -1;
    }
    triggerEnd = afterSemicolon && token === 'END';
    afterSemicolon = false;
  }
  return false;
}

export function assertSingleSqlStatement(sql: string, label: string): void {
  if (hasMultipleSqlStatements(sql)) {
    throw new Error(`${label} must contain exactly one SQL statement`);
  }
}

/** Validates the cross-platform positional-bind contract (anonymous `?` only). */
export function assertAnonymousBindParameterCount(sql: string, valueCount: number, label = 'values'): void {
  const analysis = cached(bindParameterCache, sql, () => scanAnonymousBindParameters(sql));
  if (analysis.error) throw new Error(analysis.error);
  if (analysis.count !== valueCount) {
    throw new Error(`'${label}' count mismatch: statement expects ${analysis.count}, received ${valueCount}`);
  }
}

function scanAnonymousBindParameters(sql: string): { count: number; error?: string } {
  let placeholders = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === '[') {
      i = skipBracketIdentifier(sql, i);
    } else if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
    } else if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
    } else if (ch === '?') {
      if (/\d/.test(sql[i + 1] ?? '')) {
        return {
          count: placeholders,
          error: "Only anonymous '?' placeholders are supported; numbered placeholders like '?1' are not supported",
        };
      }
      placeholders++;
    } else if ((ch === ':' || ch === '@' || ch === '$') && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      return {
        count: placeholders,
        error: 'Only anonymous ? placeholders are supported; named placeholders are not supported',
      };
    }
  }
  return { count: placeholders };
}

export function sqlStatementType(sql: string): string {
  return cached(statementTypeCache, sql, () => computeSqlStatementType(sql));
}

function computeSqlStatementType(sql: string): string {
  const first = readKeyword(sql, skipIgnorable(sql, 0));
  if (!first) return '';
  if (first.keyword !== 'WITH') return first.keyword;
  return withMainStatementType(sql, first.end) || first.keyword;
}

export function isInsertStatement(sql: string): boolean {
  const type = sqlStatementType(sql);
  return type === 'INSERT' || type === 'REPLACE';
}

export function isQueryResultStatement(sql: string): boolean {
  const type = sqlStatementType(sql);
  if (type === 'SELECT' || type === 'PRAGMA' || type === 'EXPLAIN') return true;
  if (type === 'INSERT' || type === 'UPDATE' || type === 'DELETE' || type === 'REPLACE') {
    return hasKeyword(sql, 'RETURNING');
  }
  return false;
}

// `INSERT ... ON CONFLICT (...) DO UPDATE ...` (SQLite upsert, 3.24+) can resolve as an
// UPDATE of an existing row instead of an INSERT. SQLite only updates last_insert_rowid()
// on an actual row-table INSERT, so when the DO UPDATE arm runs, last_insert_rowid() still
// reflects whatever the connection's last *real* insert was — a stale, unrelated value.
// Callers use this to fall back to `lastInsertId: 0` for any statement that could take
// that arm, rather than surface a rowid that may not correspond to the affected row.
// `run-11` (UPSERT) regression-tests this; callers that need the affected row's id for an
// UPSERT should use `query()` with a `RETURNING` clause instead.
export function hasConflictClause(sql: string): boolean {
  return cached(conflictCache, sql, () => hasKeyword(sql, 'CONFLICT'));
}

/**
 * Returns true for SQLite's statement-level `OR ROLLBACK` conflict policy.
 *
 * Unlike ABORT/FAIL, ROLLBACK can end an explicit transaction behind the
 * plugin's back. Backends which mirror transaction state in a boolean use this
 * signal to clear that mirror after a failed statement.
 */
export function hasRollbackConflictClause(sql: string): boolean {
  return cached(rollbackConflictCache, sql, () => {
    const tokens = keywords(sql);
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i] === 'OR' && tokens[i + 1] === 'ROLLBACK') return true;
    }
    return false;
  });
}

function hasTailContent(sql: string, start: number): boolean {
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (/\s/.test(ch) || ch === ';') {
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
      continue;
    }
    return true;
  }
  return false;
}

// `WITH cte1 AS (...), cte2 AS (...) <main statement>` — walks past each CTE
// definition (name, optional column list, `AS [[NOT] MATERIALIZED] (...)`) to find the
// keyword of the statement the CTEs actually feed (SELECT/INSERT/UPDATE/DELETE).
// Returns '' if the WITH clause doesn't parse as expected, in which case callers fall
// back to treating it as a plain 'WITH' statement type.
function withMainStatementType(sql: string, start: number): string {
  let i = skipIgnorable(sql, start);
  const maybeRecursive = readKeyword(sql, i);
  if (maybeRecursive?.keyword === 'RECURSIVE') {
    i = skipIgnorable(sql, maybeRecursive.end);
  }

  while (i < sql.length) {
    i = skipIdentifier(sql, i);
    if (i >= sql.length) return '';

    i = skipIgnorable(sql, i);
    if (sql[i] === '(') {
      i = skipParenthesized(sql, i);
      if (i >= sql.length) return '';
      i = skipIgnorable(sql, i);
    }

    const asKeyword = readKeyword(sql, i);
    if (asKeyword?.keyword !== 'AS') return '';
    i = skipIgnorable(sql, asKeyword.end);

    const materialized = readKeyword(sql, i);
    if (materialized?.keyword === 'NOT') {
      const next = readKeyword(sql, skipIgnorable(sql, materialized.end));
      if (next?.keyword === 'MATERIALIZED') {
        i = skipIgnorable(sql, next.end);
      }
    } else if (materialized?.keyword === 'MATERIALIZED') {
      i = skipIgnorable(sql, materialized.end);
    }

    if (sql[i] !== '(') return '';
    i = skipIgnorable(sql, skipParenthesized(sql, i));
    if (sql[i] === ',') {
      i = skipIgnorable(sql, i + 1);
      continue;
    }

    return readKeyword(sql, i)?.keyword ?? '';
  }
  return '';
}

function skipIgnorable(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch) || ch === ';') {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i) + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i) + 1;
      continue;
    }
    return i;
  }
  return i;
}

function readKeyword(sql: string, start: number): { keyword: string; end: number } | null {
  if (!/[A-Za-z_]/.test(sql[start] ?? '')) return null;
  let end = start + 1;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end++;
  return { keyword: sql.slice(start, end).toUpperCase(), end };
}

function hasKeyword(sql: string, target: string): boolean {
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === '[') {
      i = skipBracketIdentifier(sql, i);
    } else if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
    } else if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
    } else if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const keyword = readKeyword(sql, i);
      if (keyword?.keyword === target) return true;
      if (keyword) i = keyword.end - 1;
    }
  }
  return false;
}

function keywords(sql: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === '[') {
      i = skipBracketIdentifier(sql, i);
    } else if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
    } else if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
    } else if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const keyword = readKeyword(sql, i);
      if (keyword) {
        result.push(keyword.keyword);
        i = keyword.end - 1;
      }
    }
  }
  return result;
}

function skipIdentifier(sql: string, start: number): number {
  let i = skipIgnorable(sql, start);
  if (sql[i] === "'" || sql[i] === '"' || sql[i] === '`') return skipQuoted(sql, i, sql[i]) + 1;
  if (sql[i] === '[') return skipBracketIdentifier(sql, i) + 1;
  while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
  return i;
}

function skipParenthesized(sql: string, start: number): number {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === '[') {
      i = skipBracketIdentifier(sql, i);
    } else if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
    } else if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return sql.length;
}

function skipQuoted(sql: string, start: number, quote: string): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== quote) continue;
    if (sql[i + 1] === quote) {
      i++;
      continue;
    }
    return i;
  }
  return sql.length - 1;
}

function skipBracketIdentifier(sql: string, start: number): number {
  const end = sql.indexOf(']', start + 1);
  return end === -1 ? sql.length - 1 : end;
}

function skipLineComment(sql: string, start: number): number {
  for (let i = start + 2; i < sql.length; i++) {
    if (sql[i] === '\n' || sql[i] === '\r') return i;
  }
  return sql.length - 1;
}

function skipBlockComment(sql: string, start: number): number {
  for (let i = start + 2; i < sql.length - 1; i++) {
    if (sql[i] === '*' && sql[i + 1] === '/') return i + 1;
  }
  return sql.length - 1;
}
