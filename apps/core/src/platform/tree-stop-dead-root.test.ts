import { describe, expect, it } from 'vitest';
import type { Fact } from './os-kind.ts';
import { fakeProcessTable, type ProcessIdentity } from './process-identity.ts';
import { filetimeToMs, identityStartMs, type ProcessRow } from './process-table.ts';
import type { MarkerSweepScope } from './env-marker.ts';
import { stopTree } from './tree-stop.ts';

const MARKER = { name: 'AGENTDECK_TREE', value: 'tree-1' };
// 2026-11-06 07:00 UTC в FILETIME (100 нс с 1601-01-01).
const ROOT_FILETIME = 134069724000000000n;

type ScopedSweep = (
  name: string,
  value: string,
  scope?: MarkerSweepScope,
) => Promise<Fact<ProcessIdentity[]>>;

describe('identityStartMs — start of a process by its identity, alive or gone', () => {
  it('a row in the table wins; a row with an unnamed start (NaN) gives undefined', () => {
    const rows: ProcessRow[] = [
      { pid: 7, ppid: 1, start: 'x', startMs: 4242 },
      { pid: 8, ppid: 1, start: 'y', startMs: Number.NaN },
    ];
    expect(identityStartMs({ pid: 7, start: 'x' }, 'linux', rows)).toBe(4242);
    expect(identityStartMs({ pid: 8, start: 'y' }, 'linux', rows)).toBeUndefined();
  });

  it('win32 gone: FILETIME token → ms; zero or non-numeric token → undefined', () => {
    const id = { pid: 9, start: String(ROOT_FILETIME) };
    expect(identityStartMs(id, 'win32', [])).toBe(filetimeToMs(ROOT_FILETIME));
    expect(identityStartMs({ pid: 9, start: '0' }, 'win32', [])).toBeUndefined();
    expect(identityStartMs({ pid: 9, start: 'unread:9' }, 'win32', [])).toBeUndefined();
  });

  it('darwin gone: `<lstart seconds>:<hash>` → seconds × 1000', () => {
    expect(identityStartMs({ pid: 9, start: '1793952000:ab12' }, 'darwin', [])).toBe(
      1_793_952_000_000,
    );
    expect(identityStartMs({ pid: 9, start: 'nohash' }, 'darwin', [])).toBeUndefined();
  });

  it('linux gone: ticks since boot, boot start taken from a peer row of the SAME boot only', () => {
    // Сосед той же загрузки: старт 10 000 тиков = 100 с после загрузки, startMs = загрузка + 100 с.
    const boot = 1_793_900_000_000;
    const peer: ProcessRow = { pid: 2, ppid: 1, start: 'b00t1d:10000', startMs: boot + 100_000 };
    expect(identityStartMs({ pid: 9, start: 'b00t1d:25000' }, 'linux', [peer])).toBe(
      boot + 250_000,
    );
    // Другая загрузка или нет соседа — порога нет.
    expect(identityStartMs({ pid: 9, start: 'other1:25000' }, 'linux', [peer])).toBeUndefined();
    expect(identityStartMs({ pid: 9, start: 'b00t1d:25000' }, 'linux', [])).toBeUndefined();
  });
});

describe('stopTree — a root already dead still scopes the marker sweep by its own start', () => {
  it('win32: root gone from the table → sweep gets bornAfterMs from the FILETIME identity', async () => {
    const root = { pid: 400, start: String(ROOT_FILETIME) };
    // Старожил пользователя без нашей метки — в таблице, но корня в ней уже нет.
    const table = fakeProcessTable([{ pid: 49_824, ppid: 1, start: '1', startMs: 1 }]);
    const scopes: (MarkerSweepScope | undefined)[] = [];
    const sweep: ScopedSweep = async (_name, _value, scope = {}) => {
      scopes.push(scope);
      // Без порога поиск честно не уверен (нечитаемый старожил), с порогом — пусто.
      return scope.bornAfterMs === undefined
        ? { unknown: 'env-marker sweep: 1 process(es) unreadable (pid 49824)' }
        : { value: [] };
    };
    const report = await stopTree(
      root,
      { graceMs: 0, killWaitMs: 0, marker: MARKER },
      { os: 'win32', source: table, pollMs: 1, signal: () => undefined, sweep },
    );
    expect(scopes).toEqual([
      { bornAfterMs: filetimeToMs(ROOT_FILETIME) },
      { bornAfterMs: filetimeToMs(ROOT_FILETIME) },
    ]);
    expect(report.unknown).toBeUndefined();
    expect(report.residual).toEqual([]);
  });

  it('an identity whose start cannot be read stays unscoped (no guessed threshold)', async () => {
    const root = { pid: 400, start: 'unread:400' };
    const table = fakeProcessTable([]);
    const scopes: (MarkerSweepScope | undefined)[] = [];
    const sweep: ScopedSweep = async (_name, _value, scope) => {
      scopes.push(scope);
      return { value: [] };
    };
    await stopTree(
      root,
      { graceMs: 0, killWaitMs: 0, marker: MARKER },
      { os: 'win32', source: table, pollMs: 1, signal: () => undefined, sweep },
    );
    expect(scopes).toEqual([{}, {}]);
  });

  it('a bare number with the caller’s launch bound (bornAfterMs) → the sweep is scoped by that bound', async () => {
    const root = { pid: 400, start: 'unread:400' };
    const table = fakeProcessTable([]);
    const scopes: (MarkerSweepScope | undefined)[] = [];
    const sweep: ScopedSweep = async (_name, _value, scope) => {
      scopes.push(scope);
      return { value: [] };
    };
    await stopTree(
      root,
      { graceMs: 0, killWaitMs: 0, marker: MARKER, bornAfterMs: 1_793_952_000_000 },
      { os: 'win32', source: table, pollMs: 1, signal: () => undefined, sweep },
    );
    expect(scopes).toEqual([
      { bornAfterMs: 1_793_952_000_000 },
      { bornAfterMs: 1_793_952_000_000 },
    ]);
  });

  it('a readable identity wins over the caller’s bound', async () => {
    const root = { pid: 400, start: String(ROOT_FILETIME) };
    const scopes: (MarkerSweepScope | undefined)[] = [];
    const sweep: ScopedSweep = async (_name, _value, scope) => {
      scopes.push(scope);
      return { value: [] };
    };
    await stopTree(
      root,
      { graceMs: 0, killWaitMs: 0, marker: MARKER, bornAfterMs: 5 },
      { os: 'win32', source: fakeProcessTable([]), pollMs: 1, signal: () => undefined, sweep },
    );
    expect(scopes[0]).toEqual({ bornAfterMs: filetimeToMs(ROOT_FILETIME) });
  });
});
