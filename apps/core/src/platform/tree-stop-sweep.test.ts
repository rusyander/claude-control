import { describe, expect, it } from 'vitest';
import type { Fact } from './os-kind.ts';
import { fakeProcessTable, type ProcessIdentity } from './process-identity.ts';
import { stopTree } from './tree-stop.ts';

const ROOT = { pid: 400, start: 'root' };
const MARKER = { name: 'AGENTDECK_TREE', value: 'tree-1' };

/** Корень жив до первого сигнала; дальше таблица пуста — остановка «удалась». */
function harness() {
  const table = fakeProcessTable([{ pid: 400, ppid: 1, start: 'root', startMs: 1000 }]);
  return {
    table,
    deps: {
      os: 'linux' as const,
      source: table,
      pollMs: 1,
      signal: () => table.set([]),
    },
  };
}

type Sweep = (name: string, value: string) => Promise<Fact<ProcessIdentity[]>>;

describe('F-64 tree stop — a failed marker sweep is not a clean stop', () => {
  it('F-64 first sweep unreadable (env/table read failed) → unknown, never a clean []', async () => {
    const { deps } = harness();
    const sweep: Sweep = async () => ({ unknown: 'environ unreadable' });
    const report = await stopTree(
      ROOT,
      { graceMs: 0, killWaitMs: 0, marker: MARKER },
      { ...deps, sweep },
    );
    expect(report.residual).toEqual([]);
    expect(report.unknown).toMatch(/marker sweep: environ unreadable/);
  });

  it('F-64 a sweep that throws → unknown with the reason, stopTree does not throw', async () => {
    const { deps } = harness();
    const sweep: Sweep = async () => {
      throw new Error('ps exploded');
    };
    const report = await stopTree(
      ROOT,
      { graceMs: 0, killWaitMs: 0, marker: MARKER },
      { ...deps, sweep },
    );
    expect(report.unknown).toMatch(/ps exploded/);
  });

  it('F-64 only the late sweep fails (after the stop) → unknown', async () => {
    const { deps } = harness();
    let calls = 0;
    const sweep: Sweep = async () => {
      calls += 1;
      return calls === 1 ? { value: [] } : { unknown: 'late read failed' };
    };
    const report = await stopTree(
      ROOT,
      { graceMs: 0, killWaitMs: 0, marker: MARKER },
      { ...deps, sweep },
    );
    expect(report.unknown).toMatch(/late read failed/);
  });

  it('F-64 late sweep finds a process but the table re-read fails → unknown, the found one is residual', async () => {
    const { table, deps } = harness();
    let calls = 0;
    const orphan = { pid: 500, start: 'orphan' };
    const sweep: Sweep = async () => {
      calls += 1;
      if (calls === 1) return { value: [] };
      table.fail('table gone');
      return { value: [orphan] };
    };
    const report = await stopTree(
      ROOT,
      { graceMs: 0, killWaitMs: 0, marker: MARKER },
      { ...deps, sweep },
    );
    expect(report.unknown).toMatch(/table gone/);
    expect(report.residual).toContainEqual(orphan);
  });

  it('F-64 both sweeps read cleanly and nothing is left → no unknown (clean stop stays clean)', async () => {
    const { deps } = harness();
    const sweep: Sweep = async () => ({ value: [] });
    const report = await stopTree(
      ROOT,
      { graceMs: 0, killWaitMs: 0, marker: MARKER },
      { ...deps, sweep },
    );
    expect(report).toEqual({ targeted: [ROOT], sweepFound: [], residual: [] });
  });
});
