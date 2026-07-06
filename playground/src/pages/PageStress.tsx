import React, { useState, useCallback, useMemo } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { useLogger } from '../components/Logger.tsx';
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

// ── component ─────────────────────────────────────────────────────────────────

export const PageStress: React.FC = () => {
  const log = useLogger();
  const BENCHMARKS = useMemo(() => buildStressBenchmarks(CapacitorSqlite), []);
  const [results, setResults] = useState<Record<string, StressResult>>({});
  const [running, setRunning] = useState(false);

  const update = useCallback((id: string, patch: Partial<StressResult>) => {
    setResults((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { id, name: '', status: 'idle' }), ...patch } }));
  }, []);

  const runBench = useCallback(async (bench: Benchmark) => {
    update(bench.id, { id: bench.id, name: bench.name, status: 'running' });
    log.info('stress', `▶ ${bench.name}`);
    try {
      const r = await bench.run();
      update(bench.id, {
        status: 'done',
        durationMs: r.durationMs,
        throughput: r.throughput,
        detail: r.detail,
      });
      log.info('stress', `✓ ${bench.name} — ${r.durationMs}ms${r.throughput ? ` (${r.throughput})` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      update(bench.id, { status: 'error', detail: msg });
      log.error('stress', `✗ ${bench.name} — ${msg}`);
    }
  }, [update, log]);

  const runAll = useCallback(async () => {
    setRunning(true);
    for (const bench of BENCHMARKS) {
      await runBench(bench);
    }
    setRunning(false);
    log.info('stress', 'All benchmarks complete.');
  }, [runBench, log, BENCHMARKS]);

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

  return (
    <div className="space-y-4">
      {/* Header / controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="green" onClick={runAll} disabled={running}>
          {running ? 'Running…' : `Run all ${BENCHMARKS.length} benchmarks`}
        </Button>
        <Button type="neutral" onClick={clearResults} disabled={running}>Clear</Button>
        <span className="text-xs text-slate-400">Each benchmark creates and drops its own database.</span>
      </div>

      {/* Table */}
      <div className="space-y-1">
        {BENCHMARKS.map((bench) => {
          const r = results[bench.id];
          return (
            <div
              key={bench.id}
              className={`flex items-start gap-2 px-3 py-2 rounded text-sm ${rowColor(r)}`}
            >
              {/* Status icon */}
              <span className="w-5 text-center flex-shrink-0 mt-0.5">{statusIcon(r)}</span>

              {/* Name + description */}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 leading-snug">{bench.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{bench.description}</div>

                {/* Metrics row */}
                {r && r.status === 'done' && (
                  <div className="flex flex-wrap gap-3 mt-1">
                    <span className="text-xs font-semibold text-slate-700">{r.durationMs?.toLocaleString()} ms</span>
                    {r.throughput && (
                      <span className="text-xs text-indigo-700 font-semibold">{r.throughput}</span>
                    )}
                    {r.detail && (
                      <span className="text-xs text-slate-500">{r.detail}</span>
                    )}
                  </div>
                )}
                {r && r.status === 'error' && (
                  <div className="text-xs text-red-600 mt-1 truncate">{r.detail}</div>
                )}
              </div>

              {/* Run button */}
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

      {/* Aggregate summary when all done */}
      {Object.keys(results).length === BENCHMARKS.length && !running && (() => {
        const done = BENCHMARKS.map((b) => results[b.id]).filter((r) => r?.status === 'done');
        const errors = BENCHMARKS.map((b) => results[b.id]).filter((r) => r?.status === 'error');
        const totalMs = done.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
        return (
          <div className="text-sm text-slate-600 border-t pt-3">
            <span className="font-semibold">{done.length}/{BENCHMARKS.length} benchmarks passed</span>
            {errors.length > 0 && <span className="text-red-600 ml-2">({errors.length} errors)</span>}
            <span className="ml-3 text-slate-400">total time: {(totalMs / 1000).toFixed(2)}s</span>
          </div>
        );
      })()}
    </div>
  );
};
