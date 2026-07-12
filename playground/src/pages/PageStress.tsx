import React, { useState, useCallback, useMemo } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';
import { buildDiagnosticBenchmarks } from '../tests/diagnosticBenchmarks.ts';
import { buildStressBenchmarks, type Benchmark } from '../tests/stressBenchmarks.ts';

// ── types ─────────────────────────────────────────────────────────────────────

interface StressResult {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'done' | 'error';
  durationMs?: number;
  throughput?: string; // e.g. "500 rows/s"
  detail?: string;    // breakdown or error message
}

type QuietRunKind = 'stress' | 'diagnostics';

// ── component ─────────────────────────────────────────────────────────────────

export const PageStress: React.FC = () => {
  const log = useLogger();
  const BENCHMARKS = useMemo(() => buildStressBenchmarks(CapacitorSqlite), []);
  const DIAGNOSTICS = useMemo(() => buildDiagnosticBenchmarks(CapacitorSqlite), []);
  const [results, setResults] = useState<Record<string, StressResult>>({});
  const [running, setRunning] = useState(false);
  const [quietRun, setQuietRun] = useState<{ kind: QuietRunKind; count: number } | null>(null);

  const update = useCallback((id: string, patch: Partial<StressResult>) => {
    setResults((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { id, name: '', status: 'idle' }), ...patch } }));
  }, []);

  const runBench = useCallback(async (bench: Benchmark) => {
    const category = bench.id.startsWith('d-') ? 'diagnostics' : 'stress';
    update(bench.id, { id: bench.id, name: bench.name, status: 'running' });
    log.info(category, `▶ ${bench.name}`);
    try {
      const r = await bench.run();
      update(bench.id, {
        status: 'done',
        durationMs: r.durationMs,
        throughput: r.throughput,
        detail: r.detail,
      });
      log.info(category, `✓ ${bench.name} — ${r.durationMs}ms${r.throughput ? ` (${r.throughput})` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(bench.id, { status: 'error', detail: msg });
      log.error(category, `✗ ${bench.name} — ${msg}`);
    }
  }, [update, log]);

  const runMany = useCallback(async (benchmarks: Benchmark[]) => {
    const category = benchmarks[0]?.id.startsWith('d-') ? 'diagnostics' : 'stress';
    setRunning(true);
    for (const bench of benchmarks) {
      await runBench(bench);
    }
    setRunning(false);
    log.info(category, 'All benchmarks complete.');
  }, [runBench, log]);

  const runQuiet = useCallback(async (benchmarks: Benchmark[], kind: QuietRunKind) => {
    const startedAt = Date.now();
    setRunning(true);
    setQuietRun({ kind, count: benchmarks.length });
    const nextResults: Record<string, StressResult> = {};
    for (const bench of benchmarks) {
      try {
        const r = await bench.run();
        nextResults[bench.id] = {
          id: bench.id,
          name: bench.name,
          status: 'done',
          durationMs: r.durationMs,
          throughput: r.throughput,
          detail: r.detail,
        };
      } catch (e) {
        nextResults[bench.id] = {
          id: bench.id,
          name: bench.name,
          status: 'error',
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    }
    setResults(nextResults);
    setRunning(false);
    setQuietRun(null);
    const failed = Object.values(nextResults).filter((r) => r.status === 'error').length;
    log.info(
      kind,
      `Quiet ${kind} complete — ${benchmarks.length - failed}/${benchmarks.length} passed in ${Date.now() - startedAt}ms`,
    );
  }, [log]);

  const runSingle = useCallback(async (bench: Benchmark) => {
    setRunning(true);
    await runBench(bench);
    setRunning(false);
  }, [runBench]);

  const clearResults = useCallback(() => setResults({}), []);

  const statusIcon = (r?: StressResult) => {
    if (!r || r.status === 'idle') return <span className="text-slate-300">○</span>;
    if (r.status === 'running') return <span className="animate-pulse text-indigo-500">…</span>;
    if (r.status === 'done')  return <span className="text-emerald-600">✓</span>;
    return <span className="text-red-600">✗</span>;
  };

  const rowColor = (r?: StressResult) => {
    if (!r || r.status === 'idle') return 'bg-slate-50';
    if (r.status === 'running') return 'bg-indigo-50';
    if (r.status === 'done')   return 'bg-emerald-50';
    return 'bg-red-50';
  };

  const renderBenchmarks = (benchmarks: Benchmark[]) => (
    <div className="space-y-1">
      {benchmarks.map((bench) => {
        const r = results[bench.id];
        return (
          <div key={bench.id} className={`flex items-start gap-2 px-3 py-2 rounded text-sm ${rowColor(r)}`}>
            <span className="w-5 text-center flex-shrink-0 mt-0.5">{statusIcon(r)}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-slate-800 leading-snug">{bench.name}</div>
              <div className="text-xs text-slate-500 mt-0.5">{bench.description}</div>
              {r && r.status === 'done' && (
                <div className="flex flex-wrap gap-3 mt-1">
                  <span className="text-xs font-semibold text-slate-700">{r.durationMs?.toLocaleString()} ms</span>
                  {r.throughput && <span className="text-xs text-indigo-700 font-semibold">{r.throughput}</span>}
                  {r.detail && <span className="text-xs text-slate-500">{r.detail}</span>}
                </div>
              )}
              {r && r.status === 'error' && <div className="text-xs text-red-600 mt-1 truncate">{r.detail}</div>}
            </div>
            <button
              onClick={() => runSingle(bench)}
              disabled={running}
              className="text-xs text-indigo-600 hover:underline flex-shrink-0 disabled:opacity-40 mt-0.5"
            >
              run
            </button>
          </div>
        );
      })}
    </div>
  );

  const renderSummary = (benchmarks: Benchmark[]) => {
    const selected = benchmarks.map((b) => results[b.id]).filter(Boolean);
    if (selected.length !== benchmarks.length || running) return null;
    const done = selected.filter((r) => r.status === 'done');
    const errors = selected.filter((r) => r.status === 'error');
    const totalMs = done.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
    return (
      <div className="text-sm text-slate-600 border-t pt-3">
        <span className="font-semibold">{done.length}/{benchmarks.length} benchmarks passed</span>
        {errors.length > 0 && <span className="text-red-600 ml-2">({errors.length} errors)</span>}
        <span className="ml-3 text-slate-400">sum of measured intervals: {(totalMs / 1000).toFixed(2)}s</span>
      </div>
    );
  };

  if (quietRun) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <div className="max-w-md text-center space-y-3">
          <div className="text-sm font-semibold text-slate-700">
            Running quiet {quietRun.kind === 'stress' ? 'full load' : 'diagnostics'}
          </div>
          <div className="text-xs text-slate-500">
            {quietRun.count} benchmarks are running without the visible result list. The measured work is unchanged; results will render once at the end.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header / controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="green" onClick={() => runMany(BENCHMARKS)} disabled={running}>
          {running ? 'Running…' : `Run full load (${BENCHMARKS.length})`}
        </Button>
        <Button type="yellow" onClick={() => runQuiet(BENCHMARKS, 'stress')} disabled={running}>
          Run full load quiet
        </Button>
        <Button type="neutral" onClick={() => runMany(DIAGNOSTICS)} disabled={running}>
          Run diagnostics ({DIAGNOSTICS.length})
        </Button>
        <Button type="yellow" onClick={() => runQuiet(DIAGNOSTICS, 'diagnostics')} disabled={running}>
          Run diagnostics quiet
        </Button>
        <Button type="neutral" onClick={clearResults} disabled={running}>Clear</Button>
        <span className="text-xs text-slate-400">Full load keeps the original high counts; quiet mode avoids measuring the visible results UI.</span>
      </div>

      <h2 className="text-sm font-semibold text-slate-700">Full end-to-end load</h2>
      {renderBenchmarks(BENCHMARKS)}
      {renderSummary(BENCHMARKS)}

      <h2 className="text-sm font-semibold text-slate-700 pt-3">Layer diagnostics</h2>
      {renderBenchmarks(DIAGNOSTICS)}
      {renderSummary(DIAGNOSTICS)}
    </div>
  );
};
