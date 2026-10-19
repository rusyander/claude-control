import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STALL_LOG_KEEP,
  formatStallLog,
  parsePosixProcesses,
  parseWindowsProcesses,
  processTree,
  readStallProcesses,
  straysOf,
  writeStallLog,
  type StallProcess,
} from './stall-diagnostic.ts';

/**
 * Журнал повисшей группы: что держало вызов. Дерево — то, что видел сторож 19.10:
 * оболочка CLI → claude → bash → node tests-cli, рядом — осиротевшая служба esbuild
 * копии (её родитель умер, номер родителя остался мёртвым), и чужой процесс.
 */
const COPY = 'C:\\work\\shop-worktrees\\cp';
const TREE: StallProcess[] = [
  {
    pid: 10,
    ppid: 1,
    name: 'cmd.exe',
    startedAt: '2026-10-19T06:40:00.000Z',
    command: 'cmd /c claude',
  },
  {
    pid: 11,
    ppid: 10,
    name: 'claude.exe',
    startedAt: '2026-10-19T06:40:01.000Z',
    command: 'claude -p',
  },
  {
    pid: 20,
    ppid: 11,
    name: 'bash.exe',
    startedAt: '2026-10-19T06:48:00.000Z',
    command: 'bash -c "node tests-cli.mjs run"',
  },
  {
    pid: 21,
    ppid: 20,
    name: 'node.exe',
    startedAt: '2026-10-19T06:48:01.000Z',
    command: `node C:\\work\\agentdeck\\tools\\tests-cli.mjs run --project ${COPY}`,
  },
  {
    pid: 30,
    ppid: 99,
    name: 'esbuild.exe',
    startedAt: '2026-10-19T06:49:00.000Z',
    command: `${COPY}\\node_modules\\@esbuild\\win32-x64\\esbuild.exe --service=0.25.0 --ping`,
  },
  {
    pid: 40,
    ppid: 1,
    name: 'chrome.exe',
    startedAt: '2026-10-19T05:00:00.000Z',
    command: 'chrome.exe',
  },
];

describe('журнал повисшей группы: дерево процессов', () => {
  it('дерево под корнем — по родителям, с глубиной; осиротевший процесс копии — отдельно', () => {
    const tree = processTree(TREE, [10, 11]);
    expect(tree.map((entry) => [entry.process.pid, entry.depth])).toEqual([
      [10, 0],
      [11, 1],
      [20, 2],
      [21, 3],
    ]);
    expect(
      straysOf(TREE, tree, COPY.replace(/\\/g, '/').toUpperCase(), 0).map((row) => row.pid),
    ).toEqual([30]);
    // Без копии чужих не ищем.
    expect(straysOf(TREE, tree, undefined, 0)).toEqual([]);
  });

  it('корня уже нет в списке — его дети всё равно находятся', () => {
    const rows = TREE.filter((row) => row.pid !== 10);
    expect(processTree(rows, [10]).map((entry) => entry.process.pid)).toEqual([11, 20, 21]);
  });

  it('текст журнала называет группу, молчание, каждый процесс с командной строкой и стартом', () => {
    const text = formatStallLog(
      {
        key: 'p#1',
        group: 'CP',
        chatIds: ['c1'],
        silentMs: 61 * 60_000,
        copyPath: COPY,
        roots: [10],
      },
      TREE,
      new Date('2026-10-19T07:50:00Z'),
    );
    expect(text).toContain('group: CP (p#1)');
    expect(text).toContain('silent: 61 min');
    expect(text).toContain('process tree under the CLI (4):');
    expect(text).toContain('21 (ppid 20) node.exe  started 2026-10-19T06:48:01.000Z');
    expect(text).toContain('tests-cli.mjs run --project');
    expect(text).toContain('outside the tree, naming the copy (1):');
    expect(text).toContain('esbuild.exe --service');
    expect(text).not.toContain('chrome');
    expect(
      formatStallLog(
        { key: 'k', group: 'g', chatIds: [], silentMs: 0, roots: [] },
        undefined,
        new Date(0),
      ),
    ).toContain('process list: NOT READ');
  });

  it('разбор CIM: ISO и /Date()/, один объект вместо массива; ps: etime в старт', () => {
    const many = parseWindowsProcesses(
      '\uFEFF' +
        JSON.stringify([
          {
            ProcessId: 5,
            ParentProcessId: 4,
            Name: 'node.exe',
            Started: '2026-10-19T06:48:01.0000000Z',
            CommandLine: 'node a',
          },
          {
            ProcessId: 6,
            ParentProcessId: 5,
            Name: 'x.exe',
            Started: '/Date(1760856481000)/',
            CommandLine: null,
          },
        ]),
    );
    expect(many).toEqual([
      {
        pid: 5,
        ppid: 4,
        name: 'node.exe',
        startedAt: '2026-10-19T06:48:01.0000000Z',
        command: 'node a',
      },
      { pid: 6, ppid: 5, name: 'x.exe', startedAt: new Date(1760856481000).toISOString() },
    ]);
    expect(parseWindowsProcesses(JSON.stringify({ ProcessId: 7, Name: 'a' }))).toEqual([
      { pid: 7, ppid: 0, name: 'a' },
    ]);
    const now = Date.parse('2026-10-19T08:00:00Z');
    expect(
      parsePosixProcesses('  12     1 01:02:03 /usr/bin/node /x/vitest.mjs run\n bad\n', now),
    ).toEqual([
      {
        pid: 12,
        ppid: 1,
        name: 'node',
        startedAt: '2026-10-19T06:57:57.000Z',
        command: '/usr/bin/node /x/vitest.mjs run',
      },
    ]);
  });
});

describe('журнал повисшей группы: файл', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('пишет файл в каталог журналов и держит не больше предела', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stall-log-'));
    for (let i = 0; i < STALL_LOG_KEEP + 3; i += 1) {
      writeFileSync(
        join(dir, `stall-2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z-old.log`),
        'x',
      );
    }
    const path = await writeStallLog(
      dir,
      {
        key: 'родитель#0',
        group: 'G',
        chatIds: ['c'],
        silentMs: 3_600_000,
        copyPath: COPY,
        roots: [10],
      },
      async () => TREE,
      () => new Date('2026-10-19T07:50:00.123Z'),
    );
    expect(path).toBe(join(dir, 'stall-2026-10-19T07-50-00-123Z-_0.log'));
    expect(readFileSync(path, 'utf8')).toContain('tests-cli.mjs');
    const left = readdirSync(dir);
    expect(left).toHaveLength(STALL_LOG_KEEP);
    expect(left).toContain('stall-2026-10-19T07-50-00-123Z-_0.log');
  });

  it('настоящий список процессов этой машины: ребёнок теста виден под тестом со своей командой', async () => {
    const marker = `stall-marker-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, 60000) // ${marker}`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rows = await readStallProcesses();
      expect(rows).toBeDefined();
      const tree = processTree(rows ?? [], [process.pid]);
      const found = tree.find((entry) => entry.process.pid === child.pid);
      expect(found?.depth).toBe(1);
      expect(found?.process.command).toContain(marker);
      expect(found?.process.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    } finally {
      child.kill();
    }
  }, 40_000);
});
