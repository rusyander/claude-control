import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  containersByLabel,
  diffDir,
  listeningPorts,
  listenersOfTree,
  parseWorktreeList,
  snapshotDir,
} from './resource-scan.ts';
import type { ProcessRow } from './process-table.ts';
import type { TcpEntry } from './tcp-table.ts';
import type { ToolRun } from './run-tool.ts';
import type { Fact } from './os-kind.ts';

/**
 * Снимки находок конца шага (01 §Resources, P90, F25): каждый снимок — Fact, и молчащая ОС
 * или движок дают `unknown`, никогда «пусто». Подменяется только внешняя граница (таблица
 * TCP, таблица процессов, запуск `docker`); каталоги — настоящие.
 */

const root = mkdtempSync(join(tmpdir(), 'resource scan ü '));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tcp = (fact: Fact<TcpEntry[]>) => async (): Promise<Fact<TcpEntry[]>> => fact;
const row = (pid: number, ppid: number, startMs: number): ProcessRow => ({
  pid,
  ppid,
  start: `s${pid}`,
  startMs,
});
const LISTEN = (port: number, pid?: number): TcpEntry => ({
  state: 'listen',
  localAddress: '127.0.0.1',
  localPort: port,
  remoteAddress: '0.0.0.0',
  remotePort: 0,
  ...(pid === undefined ? {} : { pid }),
});

describe('P90 resource scan — listeners', () => {
  it('P90 listeningPorts: only LISTEN rows, pid kept only when the OS named it; an unread table stays unknown', async () => {
    const established: TcpEntry = { ...LISTEN(5000, 7), state: 'established' };
    expect(
      await listeningPorts('linux', tcp({ value: [LISTEN(4000, 9), LISTEN(4001), established] })),
    ).toEqual({
      value: [
        { address: '127.0.0.1', port: 4000, pid: 9 },
        { address: '127.0.0.1', port: 4001 },
      ],
    });
    expect(await listeningPorts('linux', tcp({ unknown: 'no table' }))).toEqual({
      unknown: 'no table',
    });
  });

  it('P90 listenersOfTree: ports owned by the root or its descendants only; ownerless and foreign ports excluded; either table unknown → unknown', async () => {
    const rows = [row(10, 1, 100), row(11, 10, 200), row(12, 11, 300), row(20, 1, 100)];
    const source = { read: async (): Promise<Fact<ProcessRow[]>> => ({ value: rows }) };
    const ports = tcp({ value: [LISTEN(1, 10), LISTEN(2, 12), LISTEN(3, 20), LISTEN(4)] });
    const rootId = { pid: 10, start: 's10' };
    expect(await listenersOfTree(rootId, source, 'linux', ports)).toEqual({
      value: [
        { address: '127.0.0.1', port: 1, pid: 10 },
        { address: '127.0.0.1', port: 2, pid: 12 },
      ],
    });
    const blind = { read: async (): Promise<Fact<ProcessRow[]>> => ({ unknown: 'ps down' }) };
    expect(await listenersOfTree(rootId, blind, 'linux', ports)).toEqual({ unknown: 'ps down' });
    expect(await listenersOfTree(rootId, source, 'linux', tcp({ unknown: 'tcp down' }))).toEqual({
      unknown: 'tcp down',
    });
  });
});

describe('P90 resource scan — session TMPDIR', () => {
  it('P90 snapshotDir: absent dir → absent; files and dirs with kind/size; a path that is a file → unknown, not empty', () => {
    expect(snapshotDir(join(root, 'nope'))).toEqual({ absent: true, detail: join(root, 'nope') });
    const dir = join(root, 'tmp-a');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'abc');
    const snap = snapshotDir(dir);
    if (!('value' in snap)) throw new Error(JSON.stringify(snap));
    expect(snap.value.map(({ name, kind, size }) => ({ name, kind, size }))).toEqual(
      expect.arrayContaining([
        { name: 'a.txt', kind: 'file', size: 3 },
        expect.objectContaining({ name: 'sub', kind: 'dir' }),
      ]),
    );
    expect('unknown' in snapshotDir(join(dir, 'a.txt'))).toBe(true);
  });

  it('P90 diffDir: a new name is added, a size or mtime change is changed, a vanished name is removed', () => {
    const dir = join(root, 'tmp-b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep'), 'x');
    writeFileSync(join(dir, 'touch'), 'x');
    writeFileSync(join(dir, 'grow'), 'x');
    writeFileSync(join(dir, 'gone'), 'x');
    const before = snapshotDir(dir);
    rmSync(join(dir, 'gone'));
    writeFileSync(join(dir, 'grow'), 'xxxx');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'touch'), later, later);
    writeFileSync(join(dir, 'new'), 'x');
    const after = snapshotDir(dir);
    if (!('value' in before) || !('value' in after)) throw new Error('snapshot failed');
    const diff = diffDir(before.value, after.value);
    expect(diff.added.map((r) => r.name)).toEqual(['new']);
    expect(diff.changed.map((r) => r.name).sort()).toEqual(['grow', 'touch']);
    expect(diff.removed).toEqual(['gone']);
  });
});

describe('P90 resource scan — worktrees and containers', () => {
  it('P90 parseWorktreeList: every porcelain flag read; Windows spelling with backslashes; fields before the first worktree ignored', () => {
    const out = [
      'HEAD stray',
      'worktree C:/repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree C:/repo-wt/x',
      'HEAD bbb',
      'detached',
      'locked reason',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree C:/bare',
      'bare',
      '',
    ].join('\0');
    expect(parseWorktreeList(out, 'win32')).toEqual([
      {
        path: 'C:\\repo',
        head: 'aaa',
        branch: 'refs/heads/main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: 'C:\\repo-wt\\x',
        head: 'bbb',
        detached: true,
        bare: false,
        locked: true,
        prunable: true,
      },
      { path: 'C:\\bare', detached: false, bare: true, locked: false, prunable: false },
    ]);
    // Без завершающего пустого поля последняя запись не теряется; POSIX-путь не трогается.
    expect(parseWorktreeList('worktree /r\0HEAD c', 'linux')).toEqual([
      { path: '/r', head: 'c', detached: false, bare: false, locked: false, prunable: false },
    ]);
  });

  it('P58 containersByLabel: engine missing → engine-absent, engine silent → engine-down (never "no containers"); rows parsed, blank lines skipped, a missing state column reads empty', async () => {
    const run = (result: ToolRun) => async (): Promise<ToolRun> => result;
    expect(
      await containersByLabel(
        't1',
        'docker',
        run({ ok: false, reason: 'spawn docker ENOENT', timedOut: false }),
      ),
    ).toEqual({ unknown: 'engine-absent: spawn docker ENOENT' });
    expect(
      await containersByLabel(
        't1',
        'docker',
        run({
          ok: false,
          reason: 'exit 1',
          timedOut: false,
          stderr: 'error during connect: pipe not found\nmore',
        }),
      ),
    ).toEqual({ unknown: 'engine-down: error during connect: pipe not found' });
    expect(
      await containersByLabel(
        't1',
        'docker',
        run({
          ok: true,
          code: 0,
          timedOut: false,
          stderr: '',
          stdout: 'abc\tweb\trunning\n\n   \ndef\tdb\n',
        }),
      ),
    ).toEqual({
      value: [
        { id: 'abc', name: 'web', state: 'running' },
        { id: 'def', name: 'db', state: '' },
      ],
    });
  });

  it('P58 containersByLabel: the task label AND the task compose project are read (two filters, the engine ANDs one), merged by id; a failing second read is unknown, not a half list', async () => {
    const asked: string[] = [];
    const rows: Record<string, string> = {
      'label=agentdeck.task=T1': 'abc\tweb\trunning\n',
      'label=com.docker.compose.project=agentdeck-t1':
        'abc\tweb\trunning\nfed\tproj-db-1\texited\n',
    };
    const run = async (_engine: string, args: readonly string[]): Promise<ToolRun> => {
      const filter = args[args.indexOf('--filter') + 1]!;
      asked.push(filter);
      return { ok: true, code: 0, timedOut: false, stderr: '', stdout: rows[filter] ?? '' };
    };
    expect(await containersByLabel('T1', 'docker', run)).toEqual({
      value: [
        { id: 'abc', name: 'web', state: 'running' },
        { id: 'fed', name: 'proj-db-1', state: 'exited' },
      ],
    });
    expect(asked).toEqual([
      'label=agentdeck.task=T1',
      'label=com.docker.compose.project=agentdeck-t1',
    ]);
    let calls = 0;
    const second = async (): Promise<ToolRun> =>
      ++calls === 1
        ? { ok: true, code: 0, timedOut: false, stderr: '', stdout: 'abc\tweb\trunning\n' }
        : { ok: false, reason: 'exit 1', timedOut: false, stderr: 'error during connect' };
    expect(await containersByLabel('T1', 'docker', second)).toEqual({
      unknown: 'engine-down: error during connect',
    });
  });
});
