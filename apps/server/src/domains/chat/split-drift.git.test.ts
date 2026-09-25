import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBranchFiles, readMergeTarget, readTargetMoved } from '../project-git/read.ts';
import { DRIFT_RECHECK_MS, SplitOverlap } from './split-overlap.ts';
import type { ChatEvent } from './ChatRunner.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';

/**
 * Основная ветка ушла вперёд и задела файлы идущей группы (находка 61, решение
 * владельца W3-3). Пересчёт по расписанию (61c) видел только соседей по
 * разделению: что `main` за это время переписал тот же файл, панель узнавала
 * конфликтом при слиянии. Теперь это отметка на группе и заметка с кодом;
 * ветку посреди работы панель не перестраивает — это сделает rebase доставки.
 *
 * Настоящий git с голым удалённым; подменены только часы.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

describe('дрейф основной ветки под идущей группой', { timeout: 60_000 }, () => {
  let template: string;
  let root: string;
  let main: string;
  let seed: string;
  let clock: number;
  let events: ChatEvent[];
  let records: Map<string, SplitPlanRecord>;

  beforeAll(() => {
    template = mkdtempSync(join(tmpdir(), 'cc-drift-tpl-'));
    const origin = join(template, 'origin.git');
    const seedDir = join(template, 'seed');
    git(template, 'init', '-q', '--bare', '-b', 'main', origin);
    git(template, 'clone', '-q', origin, seedDir);
    git(seedDir, 'checkout', '-q', '-b', 'main');
    commit(seedDir, { 'web/a.ts': 'a\n', 'web/b.ts': 'b\n', 'api/x.go': 'x\n' }, 'base');
    git(seedDir, 'push', '-q', 'origin', 'main');
    git(template, 'clone', '-q', origin, join(template, 'main'));
    git(seedDir, 'remote', 'set-url', 'origin', '../origin.git');
    git(join(template, 'main'), 'remote', 'set-url', 'origin', '../origin.git');
  }, 60_000);

  afterAll(() => {
    removeDir(template);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-drift-git-'));
    cpSync(template, root, { recursive: true });
    seed = join(root, 'seed');
    main = join(root, 'main');
    clock = Date.parse('2026-09-25T12:00:00.000Z');
    events = [];
    records = new Map();
  });

  afterEach(() => {
    removeDir(root);
  });

  function overlap(): SplitOverlap {
    return new SplitOverlap({
      git: {
        mergeBase: readMergeTarget,
        changedFiles: readBranchFiles,
        movedFiles: readTargetMoved,
      },
      store: {
        get: (parent) => records.get(parent),
        set: (record) => void records.set(record.parentChatId, structuredClone(record)),
        all: () => Object.fromEntries(records),
      },
      emit: (_parent, event) => {
        events.push(event);
        return true;
      },
      log: () => undefined,
      now: () => new Date(clock),
    });
  }

  /** Одна идущая группа — копия от свежей основной, работа закоммичена. */
  function runningGroup(files: Record<string, string>): string {
    const path = join(root, 'copy-g0');
    git(main, 'worktree', 'add', '-q', '-b', 'g0', path, 'origin/main');
    commit(path, files, 'g0');
    records.set('родитель', {
      parentChatId: 'родитель',
      projectPath: main,
      createdAt: '2026-09-25T11:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'Форма', branch: 'g0', tasks: ['т'] }] },
      groups: [{ index: 0, title: 'Форма', branch: 'g0', after: [], status: 'started', path }],
    });
    return path;
  }

  /** Основная ушла вперёд на удалённом, основная копия это уже знает (fetch). */
  function mainMoves(files: Record<string, string>): void {
    commit(seed, files, 'upstream');
    git(seed, 'push', '-q', 'origin', 'main');
    git(main, 'fetch', '-q', 'origin');
  }

  const drift = () => records.get('родитель')?.groups[0]?.drift;

  it('такт расписания замечает, что основная задела файл группы: отметка и заметка с кодом', async () => {
    runningGroup({ 'web/a.ts': 'a group\n' });
    const watcher = overlap();
    expect(await watcher.recheckRunning()).toEqual(['родитель']);
    expect(drift()).toBeUndefined();

    mainMoves({ 'web/a.ts': 'a main\n', 'api/x.go': 'x main\n' });
    clock += DRIFT_RECHECK_MS;
    expect(await watcher.recheckRunning()).toEqual(['родитель']);

    // Только общий файл: `api/x.go` группа не трогала.
    expect(drift()).toMatchObject({ target: 'origin/main', files: ['web/a.ts'] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'notice',
      code: 'defaultDrift',
      textCode: 'split-default-drift-notice',
      textParams: { group: 'Форма', target: 'origin/main', files: 'web/a.ts', count: '1' },
    });
    // Ветку посреди работы не трогаем: rebase — дело звена доставки.
    expect(git(main, 'rev-parse', 'g0')).not.toBe(git(main, 'rev-parse', 'origin/main'));
  });

  it('тот же дрейф второй раз не рассказывается', async () => {
    runningGroup({ 'web/a.ts': 'a group\n' });
    mainMoves({ 'web/a.ts': 'a main\n' });
    const watcher = overlap();

    await watcher.check('родитель');
    await watcher.check('родитель');

    expect(events).toHaveLength(1);
    expect(drift()?.files).toEqual(['web/a.ts']);
  });

  it('основная задела только чужие файлы — отметки нет', async () => {
    runningGroup({ 'web/a.ts': 'a group\n' });
    mainMoves({ 'api/x.go': 'x main\n' });

    await overlap().check('родитель');

    expect(drift()).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('группа перенесла ветку на свежую основную — отметка снимается', async () => {
    const path = runningGroup({ 'web/a.ts': 'a group\n' });
    mainMoves({ 'web/b.ts': 'b main\n', 'web/a.ts': 'a main\n' });
    const watcher = overlap();
    await watcher.check('родитель');
    expect(drift()?.files).toEqual(['web/a.ts']);

    git(path, 'rebase', '-q', '-X', 'ours', 'origin/main');
    await watcher.check('родитель');

    expect(drift()).toBeUndefined();
  });
});
