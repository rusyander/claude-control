import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { hasValue } from './os-kind.ts';
import {
  createLivenessProbe,
  fakeProcessTable,
  identityOfPid,
  type ProcessIdentity,
} from './process-identity.ts';
import { osProcessTable, type ProcessTableSource } from './process-table.ts';
import type { ToolRun } from './run-tool.ts';
import type { HelperOp } from './win-helper.ts';
import {
  environHas,
  judgeWinEnviron,
  parseWinEnviron,
  sweepMarker,
  type WinEnvironScan,
} from './env-marker.ts';
import { startTree, waitFor, type TreeRun } from './__fixtures__/harness.ts';

const isWin = process.platform === 'win32';
const runs: TreeRun[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.cleanup();
  for (const done of cleanups.splice(0)) done();
});

async function identity(pid: number): Promise<ProcessIdentity> {
  const id = await identityOfPid(pid);
  if (!hasValue(id)) throw new Error(`${pid}: no identity (${JSON.stringify(id)})`);
  return id.value;
}

/** Записанный вывод помощника `environ` на этой машине (28.10): 16 повышенных + 1 PPL своих. */
const RECORDED = readFileSync(new URL('./__fixtures__/win-environ.txt', import.meta.url), 'utf8');

function scan(over: Partial<WinEnvironScan> = {}): WinEnvironScan {
  return {
    readerIl: 8192,
    hits: [],
    unread: [],
    hidden: [],
    read: 10,
    gone: 0,
    other: 0,
    closed: 0,
    ...over,
  };
}

const ok = (stdout: string): ToolRun => ({
  ok: true,
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
});

/** Источник таблицы, которого на Windows-ветке быть не должно: личность — с дескриптора помощника. */
const noTable: ProcessTableSource = {
  read: () => Promise.reject(new Error('process table read on the win32 sweep')),
};

describe('P53 env-marker — whole-entry match (environHas, the helper mirrors it)', () => {
  it('entry equal to NAME=VALUE only: prefix value, longer name, value inside another var → no', () => {
    expect(environHas('A=1\0AGENTDECK_TREE=t1\0B=2\0', 'AGENTDECK_TREE', 't1')).toBe(true);
    expect(environHas('AGENTDECK_TREE=t10\0', 'AGENTDECK_TREE', 't1')).toBe(false);
    expect(environHas('X_AGENTDECK_TREE=t1\0', 'AGENTDECK_TREE', 't1')).toBe(false);
    expect(environHas('OTHER=AGENTDECK_TREE=t1\0', 'AGENTDECK_TREE', 't1')).toBe(false);
    expect(environHas('agentdeck_tree=t1\0', 'AGENTDECK_TREE', 't1')).toBe(false);
  });
});

describe('P53 env-marker — Windows helper output (recorded) and the decision by facts', () => {
  it('recorded output parses: reader level, hits, hidden with level + protection, totals', () => {
    const parsed = parseWinEnviron(RECORDED);
    expect(parsed?.readerIl).toBe(8192);
    expect(parsed?.hits).toEqual([
      { pid: 38884, start: '134376578403996920' },
      { pid: 26964, start: '134376578405617751' },
    ]);
    expect(parsed?.hidden).toHaveLength(17);
    expect(parsed?.hidden[0]).toEqual({
      pid: 9272,
      start: '134372277630459909',
      il: 8192,
      protection: 49,
    });
    expect(parsed?.hidden[1]).toEqual({
      pid: 9448,
      start: '134372277630571660',
      il: 12288,
      protection: 0,
    });
    expect(parsed).toMatchObject({ read: 459, gone: 1, other: 0, closed: 155, unread: [] });
  });

  it('CRLF and surrounding spaces are tolerated; unread lines parse; a zero start is no identity', () => {
    const parsed = parseWinEnviron(
      ' reader 4096 \r\nunread 5 77\r\nunread 6 0\r\nhit 7 0\r\nhidden 8 99 4096 -1\r\ndone 1 2 3 4\r\n',
    );
    expect(parsed).toEqual({
      readerIl: 4096,
      hits: [],
      // Метка найдена, но без времени создания — не «меченых нет», а непрочитанный свой (F-55).
      unread: [
        { pid: 5, start: '77' },
        { pid: 7, start: '' },
      ],
      hidden: [{ pid: 8, start: '99', il: 4096, protection: -1 }],
      read: 1,
      gone: 2,
      other: 3,
      closed: 4,
    });
  });

  it('cut output is not an answer: no `done` or no `reader` line → undefined', () => {
    expect(parseWinEnviron(RECORDED.replace(/^done .*$/m, ''))).toBeUndefined();
    expect(parseWinEnviron(RECORDED.replace(/^reader .*$/m, ''))).toBeUndefined();
    expect(parseWinEnviron('')).toBeUndefined();
  });

  it('recorded machine: elevated and protected unreadable processes cannot hide our marker → found ones', () => {
    const parsed = parseWinEnviron(RECORDED);
    if (!parsed) throw new Error('recorded output did not parse');
    expect(judgeWinEnviron(parsed)).toEqual({ value: parsed.hits });
    expect(judgeWinEnviron({ ...parsed, hits: [] })).toEqual({ value: [] });
  });

  it('same-user unreadable at or below our level, unprotected or protection unknown → unknown naming pids', () => {
    for (const hidden of [
      { pid: 41, start: '1', il: 8192, protection: 0 },
      { pid: 42, start: '1', il: 4096, protection: 0 },
      { pid: 43, start: '1', il: 8192, protection: -1 },
    ]) {
      const fact = judgeWinEnviron(scan({ hidden: [hidden] }));
      expect('unknown' in fact && fact.unknown).toContain(`pid ${hidden.pid}`);
      expect('unknown' in fact && fact.unknown).toContain('1 process(es)');
    }
  });

  it('above our level or protected → not counted; other user / closed token / gone only counted', () => {
    expect(
      judgeWinEnviron(
        scan({
          hidden: [
            { pid: 51, start: '1', il: 8193, protection: 0 },
            { pid: 52, start: '1', il: 8192, protection: 1 },
          ],
          other: 9,
          closed: 9,
          gone: 9,
        }),
      ),
    ).toEqual({ value: [] });
  });

  it('opened for reading, still alive, but the block unreadable → unknown', () => {
    const fact = judgeWinEnviron(scan({ unread: [{ pid: 61, start: '5' }] }));
    expect(fact).toEqual({
      unknown:
        'env-marker sweep: 1 process(es) of this user at or below our integrity level are unreadable (pid 61)',
    });
  });

  it('a hit proves itself even beside unreadable own processes; nothing readable at all → unknown', () => {
    const hit = { pid: 71, start: '9' };
    expect(
      judgeWinEnviron(scan({ hits: [hit], unread: [{ pid: 72, start: '1' }], read: 0 })),
    ).toEqual({ value: [hit] });
    expect(judgeWinEnviron(scan({ read: 0 }))).toEqual({
      unknown: 'env-marker sweep: no environment block was readable',
    });
    expect(judgeWinEnviron(scan({ read: 1 }))).toEqual({ value: [] });
  });

  it('many suspects: the count is whole, the pid list stops at eight', () => {
    const unread = Array.from({ length: 10 }, (_, i) => ({ pid: 100 + i, start: '1' }));
    const fact = judgeWinEnviron(scan({ unread }));
    expect('unknown' in fact && fact.unknown).toMatch(
      /10 process\(es\).*\(pid 100, 101, 102, 103, 104, 105, 106, 107\)$/,
    );
  });
});

describe('P53 env-marker — win32 sweep glue (helper substituted)', () => {
  it('ONE helper call per sweep, op `environ` with plan NAME=VALUE, no process-table read', async () => {
    const calls: [HelperOp, string][] = [];
    const found = await sweepMarker('M', 'v=1', noTable, 'win32', '/proc', async (op, plan) => {
      calls.push([op, plan]);
      return ok('reader 8192\nhit 12 345\ndone 3 0 0 0\n');
    });
    expect(calls).toEqual([['environ', 'M=v=1']]);
    expect(found).toEqual({ value: [{ pid: 12, start: '345' }] });
  });

  it('helper failure and cut output → unknown, never an empty list', async () => {
    const failed = await sweepMarker('M', 'v', noTable, 'win32', '/proc', async () => ({
      ok: false,
      reason: 'exit 3',
      timedOut: false,
    }));
    expect(failed).toEqual({ unknown: 'env-marker sweep: exit 3' });
    const cut = await sweepMarker('M', 'v', noTable, 'win32', '/proc', async () =>
      ok('reader 8192\nhit 12 345\n'),
    );
    expect(cut).toEqual({ unknown: 'env-marker sweep: helper output is incomplete' });
  });

  /** Время создания FILETIME (строкой, как его пишет помощник) для мс Unix. */
  const ft = (ms: number): string => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);
  const ROOT_MS = 1_780_000_000_000;

  it('scope: an unread own process born before the root is no suspect; younger and unnamed start stay', () => {
    const older = { pid: 81, start: ft(ROOT_MS - 5_000) };
    const younger = { pid: 82, start: ft(ROOT_MS + 5_000) };
    const scope = { bornAfterMs: ROOT_MS };
    expect(judgeWinEnviron(scan({ unread: [older] }), scope)).toEqual({ value: [] });
    expect(
      judgeWinEnviron(scan({ hidden: [{ ...older, il: 8192, protection: 0 }] }), scope),
    ).toEqual({ value: [] });
    expect(judgeWinEnviron(scan({ unread: [older, younger] }), scope)).toEqual({
      unknown: expect.stringMatching(/1 process\(es\).*\(pid 82\)$/),
    });
    expect(judgeWinEnviron(scan({ unread: [{ pid: 83, start: 'x' }] }), scope)).toEqual({
      unknown: expect.stringMatching(/\(pid 83\)$/),
    });
  });

  /** Помощник по очереди отдаёт заданные выводы; число вызовов — в `calls`. */
  function scripted(...outputs: (string | null)[]) {
    const calls: string[] = [];
    const helper = async (_op: HelperOp, plan: string): Promise<ToolRun> => {
      calls.push(plan);
      const out = outputs[Math.min(calls.length - 1, outputs.length - 1)];
      return out === null ? { ok: false, reason: 'exit 5', timedOut: false } : ok(out ?? '');
    };
    return { calls, helper };
  }
  const sweepWin = (helper: (op: HelperOp, plan: string) => Promise<ToolRun>) =>
    sweepMarker('M', 'v', noTable, 'win32', '/proc', helper, undefined, {
      bornAfterMs: ROOT_MS,
    });
  const young = ft(ROOT_MS + 1_000);

  it('settle: an unread own process gone or readable on the second look → nothing found, two helper calls', async () => {
    const s = scripted(
      `reader 8192\nunread 61 ${young}\ndone 5 0 0 0\n`,
      'reader 8192\ndone 5 0 0 0\n',
    );
    expect(await sweepWin(s.helper)).toEqual({ value: [] });
    expect(s.calls).toEqual(['M=v', 'M=v']);
    // Тот же номер, но другое время создания — другой процесс: прежний ушёл.
    const reused = scripted(
      `reader 8192\nunread 61 ${young}\ndone 5 0 0 0\n`,
      `reader 8192\nunread 61 ${ft(ROOT_MS + 9_000)}\ndone 5 0 0 0\n`,
    );
    expect(await sweepWin(reused.helper)).toEqual({ value: [] });
  });

  it('settle: the same process unread twice stays unknown; a hit on the second look proves itself; a failed second look keeps the first doubt', async () => {
    const twice = `reader 8192\nunread 61 ${young}\ndone 5 0 0 0\n`;
    expect(await sweepWin(scripted(twice, twice).helper)).toEqual({
      unknown:
        'env-marker sweep: 1 process(es) of this user at or below our integrity level are unreadable (pid 61)',
    });
    expect(await sweepWin(scripted(twice, 'reader 8192\nhit 62 7\ndone 5 0 0 0\n').helper)).toEqual(
      { value: [{ pid: 62, start: '7' }] },
    );
    expect(await sweepWin(scripted(twice, null).helper)).toEqual({
      unknown: expect.stringMatching(/\(pid 61\)$/),
    });
    // Без сомнения второго взгляда нет: один вызов.
    const clean = scripted('reader 8192\ndone 5 0 0 0\n');
    expect(await sweepWin(clean.helper)).toEqual({ value: [] });
    expect(clean.calls).toHaveLength(1);
  });

  it('sweep scope reaches the win32 judge: an older unread process twice over is no suspect', async () => {
    const older = `reader 8192\nunread 71 ${ft(ROOT_MS - 5_000)}\ndone 5 0 0 0\n`;
    expect(await sweepWin(scripted(older, older).helper)).toEqual({ value: [] });
  });
});

describe('P53 env-marker — Linux /proc sweep unchanged (fake /proc)', () => {
  function fakeProc(environs: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'proc-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'self'));
    for (const [pid, environ] of Object.entries(environs)) {
      mkdirSync(join(dir, pid));
      writeFileSync(join(dir, pid, 'environ'), environ, 'latin1');
    }
    // Номер без файла environ — вышел между readdir и чтением: пропускается.
    mkdirSync(join(dir, '99'));
    return dir;
  }

  it('marked pids → their table identity; zombie and table-less rows dropped; nothing marked → []', async () => {
    const proc = fakeProc({ '10': 'A=1\0T=x\0', '11': 'T=x\0', '12': 'T=xy\0', '13': 'T=x\0' });
    const table = fakeProcessTable([
      { pid: 10, ppid: 1, start: 's10', startMs: 1 },
      { pid: 11, ppid: 1, start: 's11', startMs: 1, zombie: true },
      { pid: 12, ppid: 1, start: 's12', startMs: 1 },
    ]);
    const unusedHelper = () => Promise.reject(new Error('helper on linux'));
    expect(await sweepMarker('T', 'x', table, 'linux', proc, unusedHelper)).toEqual({
      value: [{ pid: 10, start: 's10' }],
    });
    expect(await sweepMarker('T', 'none', noTable, 'linux', proc, unusedHelper)).toEqual({
      value: [],
    });
  });

  it('unreadable /proc → unknown; table unknown → that unknown', async () => {
    const missing = join(tmpdir(), `no-proc-${process.pid}-${Date.now()}`);
    const gone = await sweepMarker('T', 'x', noTable, 'linux', missing);
    expect('unknown' in gone && gone.unknown).toMatch(/^env-marker sweep: /);
    const proc = fakeProc({ '10': 'T=x\0' });
    const blind: ProcessTableSource = { read: async () => ({ unknown: 'table down' }) };
    expect(await sweepMarker('T', 'x', blind, 'linux', proc)).toEqual({ unknown: 'table down' });
  });
});

describe('P53 env-marker sweep — real processes on this OS', () => {
  it('orphaned grandchild with the marker → exactly it; prefix value, value inside another var, unmarked → never', async () => {
    // Имя на `ZZ_`: Windows хранит блок отсортированным, метка — в самом конце, и чтение
    // не всего блока (`EnvironmentSize`) её бы потеряло.
    const name = 'ZZ_AGENTDECK_TREE';
    const value = `t-${process.pid}-${Date.now()}`;
    // Ребёнок с меткой порождает отвязанного внука и выходит: внук — сирота, дереву не виден.
    const marked = startTree('root>orphan*', { [name]: value });
    // Ложные: метка — префикс более длинного значения; `NAME=VALUE` внутри значения другой
    // переменной; процесс без метки. Каждый жив во время поиска (ждём его pid-файл).
    const decoys = [
      startTree('root', { [name]: `${value}0` }),
      startTree('root', { OTHER_VAR: `${name}=${value}` }),
      startTree('root'),
    ];
    runs.push(marked, ...decoys);
    const pids = await marked.waitPids(['root', 'orphan']);
    for (const decoy of decoys) await decoy.waitPids(['root']);
    const orphan = await identity(pids.orphan as number);
    const root = await identity(pids.root as number);
    marked.exit('root');
    const probe = createLivenessProbe(undefined, 0);
    await waitFor(async () => ((await probe.isAlive(root)) === 'dead' ? true : undefined));

    // Личность находки — та же, что у таблицы процессов (номер + точный старт).
    expect(await sweepMarker(name, value)).toEqual({ value: [orphan] });
  }, 60_000);

  it.runIf(isWin)(
    'Windows: the sweeping process carries the marker → it is found (moved block), its helper never is',
    async () => {
      // Смешанный регистр: помощник снимает метку без учёта регистра, как сам Windows.
      const name = 'AgentDeck_Self_Mark';
      const value = `s-${process.pid}-${Date.now()}`;
      const self = await identity(process.pid);
      // Запись в process.env на Windows — SetEnvironmentVariableW: блок в PEB переезжает, его
      // размер меняется. Помощнику метка не передаётся — ни он, ни его conhost её не несут.
      process.env[name] = value;
      cleanups.push(() => delete process.env[name]);
      expect(await sweepMarker(name, value)).toEqual({ value: [self] });
    },
    60_000,
  );

  it.runIf(isWin)(
    'Windows: a 32-bit (WOW64) process carrying the marker is found through the native PEB',
    async () => {
      const name = 'AGENTDECK_TREE';
      const value = `w-${process.pid}-${Date.now()}`;
      const ping = join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'PING.EXE');
      const child = spawn(ping, ['-n', '60', '127.0.0.1'], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, [name]: value },
      });
      cleanups.push(() => child.kill());
      const pid = await waitFor(() => child.pid);
      const self = await identity(pid);
      const found = await sweepMarker(name, value);
      if (!hasValue(found)) throw new Error(JSON.stringify(found));
      expect(found.value).toContainEqual(self);
      // Консольному ping ОС даёт свой conhost.exe с тем же окружением — он тоже наш (ребёнок ping).
      const table = await osProcessTable().read();
      if (!hasValue(table)) throw new Error(JSON.stringify(table));
      for (const other of found.value.filter((f) => f.pid !== pid)) {
        const row = table.value.find((r) => r.pid === other.pid && r.start === other.start);
        expect(row?.ppid).toBe(pid);
      }
    },
    60_000,
  );
});
