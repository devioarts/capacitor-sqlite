export function hasMultipleSqlStatements(sql: string): boolean {
  // Tracks BEGIN/CASE ... END nesting (trigger bodies, CASE expressions) so a
  // semicolon inside one of these blocks isn't mistaken for a statement
  // separator. Only a semicolon seen while this is back at 0 is a real split.
  let blockDepth = 0;
  // `BEGIN` as the very first token is a transaction statement (`BEGIN;`,
  // `BEGIN TRANSACTION;`), not a trigger-body opener — it must not swallow the
  // semicolon that follows it ("BEGIN; DROP TABLE t" is two statements).
  const firstTokenStart = skipIgnorable(sql, 0);
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
        if ((keyword.keyword === 'BEGIN' && i !== firstTokenStart) || keyword.keyword === 'CASE') {
          blockDepth++;
        } else if (keyword.keyword === 'END' && blockDepth > 0) {
          blockDepth--;
        }
        i = keyword.end - 1;
      }
    } else if (ch === ';' && blockDepth === 0) {
      return hasTailContent(sql, i + 1);
    }
  }
  return false;
}

export function assertSingleSqlStatement(sql: string, label: string): void {
  if (hasMultipleSqlStatements(sql)) {
    throw new Error(`${label} must contain exactly one SQL statement`);
  }
}

export function sqlStatementType(sql: string): string {
  const first = readKeyword(sql, skipIgnorable(sql, 0));
  if (!first) return '';
  if (first.keyword !== 'WITH') return first.keyword;
  return withMainStatementType(sql, first.end) || first.keyword;
}

export function isInsertStatement(sql: string): boolean {
  const type = sqlStatementType(sql);
  return type === 'INSERT' || type === 'REPLACE';
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
