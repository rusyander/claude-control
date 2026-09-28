import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filetimeFromMs } from '../../lib/kill-tree.mjs';
import { killPidTree, wasStoppedOnPurpose } from '../../lib/process-tree.ts';
import {
  ancestorsOf,
  hostOf,
  listCliProcesses,
  locateSession,
  parseEtime,
  parseUnixCli,
  parseWindowsCli,
  sessionIdsInCommand,
  shortCommand,
  stopSessionProcess,
  transcriptIsWriting,
  type CliProcess,
  type StopDeps,
} from './session-process.ts';

/**
 * «Перейти» / «Остановить» у сессий аналитики: какой процесс ведёт сессию и
 * можно ли его снять. Снимаем ТОЛЬКО то, что человек видел в окне
 * подтверждения, — номер мог освободиться и достаться чужому процессу.
 */

const ID = 'f104fdda-599b-4973-a272-fe5a515c08b7';
const OTHER = '0081374f-4507-4fd4-a328-9a6dedb8fb21';
const VSCODE = `c:\\Users\\me\\.vscode\\extensions\\anthropic.claude-code-2.1.282-win32-x64\\resources\\native-binary\\claude.exe --output-format stream-json --resume=${ID} --setting-sources=user`;

const cli = (partial: Partial<CliProcess>): CliProcess => ({
  pid: 100,
  ppid: 1,
  startedAtMs: 1_000_000,
  commandLine: `claude --resume ${ID}`,
  ...partial,
});

describe('sessionIdsInCommand', () => {
  it('находит номер в --resume=, --resume, -r и --session-id', () => {
    expect(sessionIdsInCommand(VSCODE)).toEqual([ID]);
    expect(sessionIdsInCommand(`claude --resume ${ID}`)).toEqual([ID]);
    expect(sessionIdsInCommand(`claude -r "${ID.toUpperCase()}"`)).toEqual([ID]);
    expect(sessionIdsInCommand(`node cli.js -p --session-id ${ID}`)).toEqual([ID]);
  });

  it('не принимает номер без флага и флаг внутри чужого слова', () => {
    expect(sessionIdsInCommand(`claude ${ID}`)).toEqual([]);
    expect(sessionIdsInCommand(`claude --permission-r ${ID}`)).toEqual([]);
    expect(sessionIdsInCommand('claude --resume not-a-uuid')).toEqual([]);
  });
});

describe('hostOf и shortCommand', () => {
  it('расширение VS Code — редактор, остальное — терминал', () => {
    expect(hostOf(VSCODE)).toEqual({ host: 'editor', editor: 'VS Code' });
    expect(hostOf('/home/me/.cursor/extensions/x/claude --resume 1')).toEqual({
      host: 'editor',
      editor: 'Cursor',
    });
    expect(hostOf(`claude --resume ${ID}`)).toEqual({ host: 'terminal' });
  });

  it('путь к исполняемому — одним именем, длина в меру', () => {
    expect(shortCommand(VSCODE)).toMatch(/^claude\.exe --output-format stream-json --resume=/);
    expect(shortCommand('"C:\\Program Files\\node.exe" cli.js -p')).toBe('node.exe cli.js -p');
    expect(shortCommand(`claude ${'x'.repeat(400)}`).length).toBe(160);
  });
});

describe('ancestorsOf', () => {
  const at = (ms: number) => filetimeFromMs(ms);

  it('поднимается по родителям, созданным раньше ребёнка', () => {
    const table = [
      { pid: 10, ppid: 1, created: at(1000) },
      { pid: 20, ppid: 10, created: at(2000) },
      { pid: 30, ppid: 20, created: at(3000) },
    ];
    expect([...ancestorsOf(table, 30)]).toEqual([20, 10]);
  });

  it('сирота с чужим номером родителя — не потомок', () => {
    // Номер 10 достался процессу, созданному ПОЗЖЕ «ребёнка»: связи нет.
    const table = [
      { pid: 10, ppid: 1, created: at(5000) },
      { pid: 30, ppid: 10, created: at(3000) },
    ];
    expect([...ancestorsOf(table, 30)]).toEqual([]);
  });
});

describe('locateSession', () => {
  const base = {
    panelRuns: [],
    processes: [],
    panelAncestors: new Set<number>(),
    isWriting: false,
  };

  it('идущий прогон панели — чат, даже если процесс с тем же номером есть', () => {
    expect(
      locateSession(ID, {
        ...base,
        panelRuns: [{ chatId: 'new-1', sessionId: ID, status: 'running' }],
        processes: [cli({})],
      }),
    ).toEqual({ kind: 'panel', chatId: 'new-1' });
  });

  it('завершённый прогон панели не считается идущим', () => {
    expect(
      locateSession(ID, { ...base, panelRuns: [{ chatId: ID, sessionId: ID, status: 'done' }] }),
    ).toEqual({ kind: 'finished' });
  });

  it('процесс вне панели — самый свежий из названных этим номером', () => {
    const where = locateSession(ID, {
      ...base,
      processes: [
        cli({ pid: 1, startedAtMs: 1000, commandLine: VSCODE }),
        cli({ pid: 2, startedAtMs: 5000, commandLine: VSCODE }),
        cli({ pid: 3, startedAtMs: 9000, commandLine: `claude --resume ${OTHER}` }),
      ],
      panelAncestors: new Set([2]),
    });
    expect(where).toMatchObject({
      kind: 'process',
      pid: 2,
      startedAt: new Date(5000).toISOString(),
      host: 'editor',
      editor: 'VS Code',
      ownsPanel: true,
    });
  });

  it('пишется, но процесса нет — неопознана; не пишется — завершена', () => {
    expect(locateSession(ID, { ...base, isWriting: true })).toEqual({ kind: 'unidentified' });
    expect(locateSession(ID, base)).toEqual({ kind: 'finished' });
  });
});

describe('разбор списков процессов', () => {
  it('CIM: только CLI, время из /Date(ms)/, объект вместо массива', () => {
    const one = JSON.stringify({
      ProcessId: 7,
      ParentProcessId: 3,
      CommandLine: `claude --resume ${ID}`,
      CreationDate: '/Date(1782374724422)/',
    });
    expect(parseWindowsCli(`\uFEFF${one}`)).toEqual([
      { pid: 7, ppid: 3, startedAtMs: 1782374724422, commandLine: `claude --resume ${ID}` },
    ]);
    const tsserver = JSON.stringify([
      { ProcessId: 8, CommandLine: 'node tsserver.js', CreationDate: '/Date(1)/' },
    ]);
    expect(parseWindowsCli(tsserver)).toEqual([]);
  });

  it('ps: возраст etime → время создания', () => {
    const rows = parseUnixCli(`  42   1   00:30 claude --resume ${ID}\n 43 1 00:05 vim\n`, 100_000);
    expect(rows).toEqual([
      { pid: 42, ppid: 1, startedAtMs: 70_000, commandLine: `claude --resume ${ID}` },
    ]);
  });

  it('etime: все формы и мусор', () => {
    expect(parseEtime('05')).toBeUndefined();
    expect(parseEtime('01:02')).toBe(62);
    expect(parseEtime('01:02:03')).toBe(3_723);
    expect(parseEtime('2-01:02:03')).toBe(2 * 86_400 + 3_723);
    expect(parseEtime('abc')).toBeUndefined();
  });
});

describe('transcriptIsWriting', () => {
  it('свежий файл пишется, старый — нет, отсутствующий — нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-writing-'));
    try {
      const file = join(dir, `${ID}.jsonl`);
      writeFileSync(file, '{}\n');
      expect(transcriptIsWriting(file)).toBe(true);
      const old = (Date.now() - 11 * 60 * 1000) / 1000;
      utimesSync(file, old, old);
      expect(transcriptIsWriting(file)).toBe(false);
      expect(transcriptIsWriting(undefined)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stopSessionProcess — сверка перед снятием', () => {
  const deps = (over: Partial<StopDeps> & { rows?: CliProcess[]; killed?: number[] }) => {
    const calls: number[] = [];
    const alive = new Set((over.rows ?? []).map((row) => row.pid));
    const d: StopDeps = {
      list: async () => over.rows ?? [],
      ancestors: async () => new Set(),
      kill: (pid) => {
        calls.push(pid);
        alive.delete(pid);
        return over.killed ?? [pid, pid + 1];
      },
      alive: (pid) => alive.has(pid),
      wait: async () => undefined,
      ...over,
    };
    return { d, calls };
  };
  const shown = { pid: 100, startedAt: new Date(1_000_000).toISOString() };

  it('процесса уже нет — gone, никого не трогаем', async () => {
    const { d, calls } = deps({ rows: [] });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'gone', pid: 100 });
    expect(calls).toEqual([]);
  });

  it('под номером другая сессия — reused, никого не трогаем', async () => {
    const { d, calls } = deps({ rows: [cli({ commandLine: `claude --resume ${OTHER}` })] });
    expect((await stopSessionProcess(ID, shown, d)).result).toBe('reused');
    expect(calls).toEqual([]);
  });

  it('тот же номер сессии, но процесс создан позже показанного — reused', async () => {
    const { d, calls } = deps({ rows: [cli({ startedAtMs: 1_000_000 + 5_000 })] });
    expect((await stopSessionProcess(ID, shown, d)).result).toBe('reused');
    expect(calls).toEqual([]);
  });

  it('из этой сессии запущена панель — без отмашки не снимаем', async () => {
    const { d, calls } = deps({ rows: [cli({})], ancestors: async () => new Set([100]) });
    expect((await stopSessionProcess(ID, shown, d)).result).toBe('owns-panel');
    expect(calls).toEqual([]);
    const { d: d2, calls: calls2 } = deps({
      rows: [cli({})],
      ancestors: async () => new Set([100]),
    });
    expect((await stopSessionProcess(ID, { ...shown, allowPanel: true }, d2)).result).toBe(
      'stopped',
    );
    expect(calls2).toEqual([100]);
  });

  it('предков панели узнать не удалось — unverified, никого не трогаем', async () => {
    const { d, calls } = deps({ rows: [cli({})], ancestors: async () => undefined });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'unverified', pid: 100 });
    expect(calls).toEqual([]);
  });

  it('снят и номера нет — stopped с числом снятых', async () => {
    const { d, calls } = deps({ rows: [cli({})] });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({
      result: 'stopped',
      pid: 100,
      killed: 2,
    });
    expect(calls).toEqual([100]);
  });

  /**
   * Снятие ничего не тронуло — `killPidTree` отдаёт `[]` по трём разным
   * причинам, и человеку они говорят разное (F-145). Отличает их повторная
   * сверка тем же списком, что и до снятия.
   */
  it('снятие отказалось: номер занят другим процессом позже сверки — reused, никаких «остановлено»', async () => {
    let listed = 0;
    const { d } = deps({
      rows: [cli({})],
      // Вторая сверка видит под номером процесс, созданный уже после первой.
      list: async () => [cli(listed++ === 0 ? {} : { startedAtMs: 1_000_000 + 60_000 })],
      kill: () => [],
      alive: () => true,
    });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'reused', pid: 100 });
  });

  it('снятие отказалось, а под номером тот же процесс сессии — unverified, а не «уже нет»', async () => {
    const { d } = deps({ rows: [cli({})], kill: () => [], alive: () => true });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'unverified', pid: 100 });
  });

  it('снятие отказалось, а номер нечем опознать (не в списке CLI) — unverified', async () => {
    let listed = 0;
    const { d } = deps({
      rows: [cli({})],
      list: async () => (listed++ === 0 ? [cli({})] : []),
      kill: () => [],
      alive: () => true,
    });
    expect((await stopSessionProcess(ID, shown, d)).result).toBe('unverified');
  });

  /**
   * F-145b: первая же сверка — тот же список CLI. Список не ответил (таймаут
   * CIM/`ps`) или ответил без этого номера, а номер жив — опознать его нечем,
   * и это `unverified`, а не «процесса уже нет»: иначе человек уходил, оставив
   * CLI работать.
   */
  it('список CLI не ответил, а номер жив — unverified, никого не трогаем', async () => {
    const { d, calls } = deps({ list: async () => undefined, alive: () => true });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'unverified', pid: 100 });
    expect(calls).toEqual([]);
  });

  it('список CLI не ответил, а номер мёртв — gone', async () => {
    const { d, calls } = deps({ list: async () => undefined, alive: () => false });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'gone', pid: 100 });
    expect(calls).toEqual([]);
  });

  it('номера нет в списке CLI, но он жив — unverified, а не «уже нет»', async () => {
    const { d, calls } = deps({ rows: [], alive: () => true });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'unverified', pid: 100 });
    expect(calls).toEqual([]);
  });

  it('снятие отказалось, потому что процесс вышел сам между сверкой и снятием — gone', async () => {
    const { d } = deps({ rows: [cli({})], kill: () => [], alive: () => false });
    expect(await stopSessionProcess(ID, shown, d)).toEqual({ result: 'gone', pid: 100 });
  });

  it('сигнал ушёл, а процесс жив — still-running, а не «остановлено»', async () => {
    const { d } = deps({ rows: [cli({})], alive: () => true });
    expect((await stopSessionProcess(ID, shown, d)).result).toBe('still-running');
  });
});

describe('настоящий процесс, запущенный этим тестом', () => {
  const children: ChildProcess[] = [];
  let dir = '';

  afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('опознан по --resume и снят вместе с потомком', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-session-stop-'));
    // Имя `claude.js` — чтобы список CLI признал процесс агентом; внутри —
    // только сон и один потомок, ничего настоящего.
    const fake = join(dir, 'claude.js');
    writeFileSync(
      fake,
      [
        "const { spawn } = require('node:child_process');",
        "const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "require('node:fs').writeFileSync(process.argv[4], String(kid.pid));",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const kidFile = join(dir, 'kid.pid');
    const child = spawn(process.execPath, [fake, '--resume', ID, kidFile], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid as number;

    let found: CliProcess | undefined;
    for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
      await new Promise((done) => setTimeout(done, 300));
      found = (await listCliProcesses())?.find((item) => item.pid === pid);
    }
    expect(found, 'процесс не найден в списке CLI').toBeDefined();
    const where = locateSession(ID, {
      panelRuns: [],
      processes: [found as CliProcess],
      panelAncestors: new Set(),
      isWriting: true,
    });
    expect(where).toMatchObject({ kind: 'process', pid, host: 'terminal' });

    const kidPid = Number(readFileSync(kidFile, 'utf8'));
    const startedAt = where.kind === 'process' ? where.startedAt : '';

    // Показанное время чужое (на минуту раньше) — не трогаем.
    const early = new Date(Date.parse(startedAt) - 60_000).toISOString();
    expect((await stopSessionProcess(ID, { pid, startedAt: early })).result).toBe('reused');
    expect(child.exitCode).toBeNull();

    const exited = new Promise((done) => child.once('exit', done));
    const result = await stopSessionProcess(ID, { pid, startedAt });
    expect(result.result).toBe('stopped');
    expect(result.killed).toBeGreaterThanOrEqual(2);
    // F-110: снятие помечено нарочным — иначе на Windows код выхода 1 читается
    // наблюдателем как падение CLI.
    expect(wasStoppedOnPurpose(pid), 'снятие не помечено нарочным').toBe(true);
    expect(wasStoppedOnPurpose(kidPid), 'потомок не помечен нарочным').toBe(true);
    await exited;
    const kidAlive = (() => {
      try {
        process.kill(kidPid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(kidAlive, 'потомок пережил снятие').toBe(false);

    // Второй стоп того же — честное «уже нет».
    expect((await stopSessionProcess(ID, { pid, startedAt })).result).toBe('gone');
  }, 60_000);

  /**
   * F-145: снимка процессов нет (таймаут или отказ системы, F-205) — снятие со
   * сверкой времени честно не трогает номер и отдаёт `[]`. Раньше это читалось
   * «процесса уже не было», хотя CLI сессии жив и работает. Настоящие здесь
   * процесс, список CLI, проверка жизни и `killPidTree`; подменён только снимок.
   */
  it('снимка процессов нет — не «уже нет»: unverified, процесс не тронут и жив', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-session-stop-'));
    const fake = join(dir, 'claude.js');
    writeFileSync(fake, 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [fake, '--resume', ID], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid as number;

    let found: CliProcess | undefined;
    for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
      await new Promise((done) => setTimeout(done, 300));
      found = (await listCliProcesses())?.find((item) => item.pid === pid);
    }
    expect(found, 'процесс не найден в списке CLI').toBeDefined();
    const startedAt = new Date((found as CliProcess).startedAtMs).toISOString();

    const result = await stopSessionProcess(
      ID,
      { pid, startedAt },
      {
        list: listCliProcesses,
        ancestors: async () => new Set(),
        kill: (target, spawnedAt) =>
          killPidTree(target, { spawnedAt }, { platform: 'win32', readTable: () => undefined }),
        alive: (target) => {
          try {
            process.kill(target, 0);
            return true;
          } catch {
            return false;
          }
        },
        wait: (ms) => new Promise((done) => setTimeout(done, ms)),
      },
    );
    expect(result).toEqual({ result: 'unverified', pid });
    expect(child.exitCode, 'процесс снят вслепую').toBeNull();
  }, 60_000);

  /**
   * F-145b: список CLI не получен вовсе — настоящий `listCliProcesses` без
   * `powershell`/`ps` в PATH (то же, что таймаут CIM: исполнение отказало).
   * Раньше отказ читался пустым списком, и живой процесс сессии назывался
   * «уже не было». Настоящие здесь процесс, список, проверка жизни и снятие.
   */
  it('список процессов не получен — undefined, и живой процесс не «уже нет»', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-session-stop-'));
    const fake = join(dir, 'claude.js');
    writeFileSync(fake, 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [fake, '--resume', ID], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid as number;
    const startedAt = new Date().toISOString();

    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await listCliProcesses(), 'отказ списка неотличим от пустого').toBeUndefined();
      expect(await stopSessionProcess(ID, { pid, startedAt })).toEqual({
        result: 'unverified',
        pid,
      });
    } finally {
      process.env.PATH = savedPath;
    }
    expect(child.exitCode, 'процесс снят вслепую').toBeNull();
  }, 60_000);
});
