import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { provenOwn, type OwnerRow } from './group-process-owner.ts';
import { printedPidsIn } from './printed-pids.ts';

/**
 * D-8 (25.10): группа подняла два dev-сервера (`npm … run dev -- --port 5180` и
 * `--port 5181`), увидела их номера в своём же `netstat` и погасила их по номеру
 * (`taskkill //PID 6968`). При старте панели процессов уже нет — дерева и метки
 * не прочесть, и погашение судилось чужим. Номер, который разговор группы сам
 * напечатал о своём запуске, — её: строка `netstat` для порта, на котором она
 * запускала, или эхо `$!` после своего фонового запуска.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-25T22:46:05.208Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const call = (id: string, command: string, offsetMs: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(offsetMs),
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
const result = (id: string, text: string, offsetMs: number) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(offsetMs),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });

function transcript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-printed-'));
  dirs.push(dir);
  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** Строки `netstat -ano` дословно из разговора D-8; :5173 — dev-сервер владельца. */
const NETSTAT = [
  '  TCP    [::1]:5173             [::]:0                 LISTENING       1111',
  '  TCP    [::1]:5180             [::]:0                 LISTENING       6968',
  '  TCP    [::1]:5181             [::]:0                 LISTENING       30548',
].join('\n');

const D8 = [
  call(
    't1',
    'npm --prefix /c/work/acme/inst-admin-ui run dev -- --port 5180 --strictPort > .agent/e6-vite-before.log 2>&1',
    0,
  ),
  call(
    't2',
    'npm --prefix inst-admin-ui run dev -- --port 5181 --strictPort > .agent/e6-vite-after.log 2>&1',
    1_000,
  ),
  call(
    't3',
    'tail -15 .agent/e6-vite-before.log; netstat -ano | grep LISTENING | grep ":51"',
    160_000,
  ),
  result('t3', NETSTAT, 161_000),
];

describe('printedPidsIn — номера, которые разговор группы напечатал о своём запуске', () => {
  it('D-8: строки netstat портов своего запуска — свои; порт владельца — нет', () => {
    const printed = printedPidsIn(transcript(D8));
    expect([...printed.keys()].sort()).toEqual([30548, 6968]);
    expect(printed.get(6968)).toEqual({ notBeforeMs: T0, notAfterMs: T0 + 161_000 });
  });

  it('netstat раньше запуска на этом порту — не свой', () => {
    const lines = [
      call('t0', 'netstat -ano | grep LISTENING', -5_000),
      result('t0', NETSTAT, -4_000),
      ...D8.slice(0, 2),
    ];
    expect(printedPidsIn(transcript(lines)).size).toBe(0);
  });

  it('netstat вызван раньше запуска, а его вывод лёг позже — не свой', () => {
    const lines = [
      call('n0', 'netstat -ano | grep LISTENING', 0),
      call('n1', 'npm run dev -- --port 5180', 500),
      result('n0', NETSTAT, 1_000),
    ];
    expect(printedPidsIn(transcript(lines)).size).toBe(0);
  });

  it('повторный запуск на том же порту — окно от первого: сервер мог остаться от него', () => {
    const lines = [
      ...D8.slice(0, 2),
      call('t9', 'npm run dev -- --port 5180', 100_000),
      ...D8.slice(2),
    ];
    expect(printedPidsIn(transcript(lines)).get(6968)?.notBeforeMs).toBe(T0);
  });

  it('эхо `$!` после своего фонового запуска — свой; число в выводе без `$!` — нет', () => {
    const lines = [
      call('b1', 'node server.mjs > .agent/tmp/s.log 2>&1 & echo "pid $!"', 0),
      result('b1', 'pid 4242', 500),
      call('b2', 'wc -l .agent/tmp/s.log', 1_000),
      result('b2', '777', 1_500),
    ];
    const printed = printedPidsIn(transcript(lines));
    expect([...printed.keys()]).toEqual([4242]);
  });

  it('Linux `ss -ltnp` порта своего запуска — свой', () => {
    const lines = [
      call('l1', 'PORT=5300 node server.mjs &', 0),
      call('l2', 'ss -ltnp | grep 5300', 2_000),
      result(
        'l2',
        'LISTEN 0      511          *:5300            *:*    users:(("node",pid=5151,fd=23))',
        2_500,
      ),
    ];
    expect([...printedPidsIn(transcript(lines)).keys()]).toEqual([5151]);
  });

  it('файла нет — пусто', () => {
    expect(printedPidsIn(join(tmpdir(), 'no-such-dir-x', 'a.jsonl')).size).toBe(0);
  });
});

describe('provenOwn — напечатанный номер (D-8)', () => {
  const filetime = (ms: number): bigint => BigInt(ms + 11_644_473_600_000) * 10_000n;
  const printed = new Map([[6968, { notBeforeMs: T0, notAfterMs: T0 + 161_000 }]]);

  it('процесса уже нет — гасить нечего, свой', () => {
    expect(provenOwn([], [6968], { tree: new Set(), printed })).toEqual(new Set([6968]));
  });

  it('процесс заведён между запуском и печатью — свой', () => {
    const rows: OwnerRow[] = [{ pid: 6968, ppid: 1, created: filetime(T0 + 3_000) }];
    expect(provenOwn(rows, [6968], { tree: new Set(), printed })).toEqual(new Set([6968]));
  });

  it('номер у процесса старше запуска или моложе печати (номер занят заново) — не свой', () => {
    for (const created of [T0 - 60_000, T0 + 600_000]) {
      const rows: OwnerRow[] = [{ pid: 6968, ppid: 1, created: filetime(created) }];
      expect(provenOwn(rows, [6968], { tree: new Set(), printed }).size, String(created)).toBe(0);
    }
    const unknown: OwnerRow[] = [{ pid: 6968, ppid: 1, created: 0n }];
    expect(provenOwn(unknown, [6968], { tree: new Set(), printed }).size).toBe(0);
  });

  it('номер, которого разговор не печатал, — не свой', () => {
    expect(provenOwn([], [1111], { tree: new Set(), printed }).size).toBe(0);
  });
});
