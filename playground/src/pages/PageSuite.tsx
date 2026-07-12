import React, { useState, useCallback, useMemo } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';
import { runTestCase, type TestCase, type TestResult } from '../helpers/testRunner.ts';
import { buildSuiteTests } from '../tests/suiteTests.ts';

// ── component ─────────────────────────────────────────────────────────────────

export const PageSuite: React.FC = () => {
  const log = useLogger();
  const TESTS = useMemo(() => buildSuiteTests(CapacitorSqlite), []);
  const GROUPS = useMemo(() => [...new Set(TESTS.map((t) => t.group))], [TESTS]);
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string>('All');

  const visibleTests = selectedGroup === 'All'
    ? TESTS
    : TESTS.filter((t) => t.group === selectedGroup);

  const runAll = useCallback(async () => {
    setRunning(true);
    setResults([]);
    const out: TestResult[] = [];
    for (const tc of visibleTests) {
      const r = await runTestCase(tc);
      out.push(r);
      setResults([...out]);
      const status = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
      log[r.pass ? 'info' : 'error']('suite', `[${status}] ${r.group} / ${r.name} (${r.durationMs}ms)${r.message === 'OK' ? '' : ` — ${r.message}`}`);
    }
    setRunning(false);
    const passed = out.filter((r) => r.pass && !r.skipped).length;
    const skipped = out.filter((r) => r.skipped).length;
    log.info('suite', `Done: ${passed}/${out.length} passed, ${skipped} skipped`);
  }, [visibleTests, log]);

  const runSingle = useCallback(async (tc: TestCase) => {
    const r = await runTestCase(tc);
    setResults((prev) => {
      const next = prev.filter((x) => x.id !== tc.id);
      return [...next, r];
    });
    const status = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
    log[r.pass ? 'info' : 'error']('suite', `[${status}] ${r.group} / ${r.name} (${r.durationMs}ms)${r.message === 'OK' ? '' : ` — ${r.message}`}`);
  }, [log]);

  const resultMap = Object.fromEntries(results.map((r) => [r.id, r]));
  const totalPass = results.filter((r) => r.pass && !r.skipped).length;
  const totalSkip = results.filter((r) => r.skipped).length;
  const totalFail = results.filter((r) => !r.pass).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="green" onClick={runAll} disabled={running}>
          {running ? 'Running…' : `Run ${visibleTests.length} tests`}
        </Button>
        <Button type="neutral" onClick={() => setResults([])}>Clear results</Button>

        <div className="flex items-center gap-1">
          <span className="text-sm text-slate-500">Group:</span>
          <select
            className="border border-slate-300 rounded px-2 py-1 text-sm"
            value={selectedGroup}
            onChange={(e) => setSelectedGroup(e.target.value)}
          >
            <option>All</option>
            {GROUPS.map((g) => <option key={g}>{g}</option>)}
          </select>
        </div>

        {results.length > 0 && (
          <span className="text-sm font-semibold">
            <span className="text-emerald-700">{totalPass} pass</span>
            {totalSkip > 0 && <span className="text-amber-600 ml-2">{totalSkip} skip</span>}
            {totalFail > 0 && <span className="text-red-600 ml-2">{totalFail} fail</span>}
          </span>
        )}
      </div>

      <div className="space-y-1">
        {visibleTests.map((tc) => {
          const r = resultMap[tc.id];
          return (
            <div
              key={tc.id}
              className={[
                'flex items-center gap-2 px-3 py-1.5 rounded text-sm',
                r ? (r.skipped ? 'bg-amber-50' : r.pass ? 'bg-emerald-50' : 'bg-red-50') : 'bg-slate-50',
              ].join(' ')}
            >
              <span className="w-5 text-center flex-shrink-0">
                {r ? (r.skipped ? '↷' : r.pass ? '✓' : '✗') : '○'}
              </span>
              <span className="text-slate-500 text-xs w-20 flex-shrink-0">{tc.group}</span>
              <span className="flex-1 text-slate-800">{tc.name}</span>
              {r && !r.pass && (
                <span className="text-red-600 text-xs truncate max-w-xs" title={r.message}>{r.message}</span>
              )}
              {r?.skipped && <span className="text-amber-700 text-xs truncate max-w-xs">{r.message}</span>}
              {r && <span className="text-slate-400 text-xs flex-shrink-0">{r.durationMs}ms</span>}
              <button
                onClick={() => runSingle(tc)}
                disabled={running}
                className="text-xs text-indigo-600 hover:underline flex-shrink-0 disabled:opacity-40"
              >
                run
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
