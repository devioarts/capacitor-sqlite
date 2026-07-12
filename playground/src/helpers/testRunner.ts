// ── assertion helpers ─────────────────────────────────────────────────────────

export function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Inline the union type (not SqliteResult<T>) so the T constraint doesn't widen
// property access to `unknown` under TypeScript 6 strict generic rules.
export function assertOk<T>(
  result: { success: true; data: T } | { success: false; error: { code: string; message: string } },
  label: string,
): T {
  if (!result.success) {
    throw new Error(`${label}: expected success, got error [${result.error.code}] ${result.error.message}`);
  }
  return result.data;
}

export function assertFail(
  result: { success: boolean; error?: { code?: string; message?: string } },
  label: string,
  expectedCode?: string,
): void {
  if (result.success) {
    throw new Error(`${label}: expected failure, but got success`);
  }
  if (expectedCode && result.error?.code !== expectedCode) {
    throw new Error(
      `${label}: expected error code ${expectedCode}, got ${result.error?.code} (${result.error?.message})`,
    );
  }
}

// ── test runner ───────────────────────────────────────────────────────────────

export interface TestCase {
  id: string;
  group: string;
  name: string;
  fn: () => Promise<void>;
}

class TestSkip extends Error {}

/** Marks a capability/platform exclusion explicitly instead of counting it as a pass. */
export function skipTest(reason: string): never {
  throw new TestSkip(reason);
}

export interface TestResult {
  id: string;
  group: string;
  name: string;
  pass: boolean;
  skipped: boolean;
  message: string;
  durationMs: number;
}

export async function runTestCase(tc: TestCase): Promise<TestResult> {
  const start = Date.now();
  try {
    await tc.fn();
    return {
      id: tc.id,
      group: tc.group,
      name: tc.name,
      pass: true,
      skipped: false,
      message: 'OK',
      durationMs: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof TestSkip) {
      return {
        id: tc.id,
        group: tc.group,
        name: tc.name,
        pass: true,
        skipped: true,
        message: e.message,
        durationMs: Date.now() - start,
      };
    }
    return {
      id: tc.id,
      group: tc.group,
      name: tc.name,
      pass: false,
      skipped: false,
      message: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start,
    };
  }
}
