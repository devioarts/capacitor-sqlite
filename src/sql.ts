export function hasMultipleSqlStatements(sql: string): boolean {
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
    } else if (ch === ';') {
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
