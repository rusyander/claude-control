import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBranchFiles, readMergeTarget, readWorktreeHead } from '../project-git/read.ts';
import { DRIFT_RECHECK_MS, SplitOverlap } from './split-overlap.ts';
import type { ChatEvent } from './ChatRunner.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';

/**
 * Пересечения веток на НАСТОЯЩЕМ git — находки 52 и 61c живого прогона 24.09.2026.
 *
 * 52: локальный `main` основной копии отстал от `origin/main`, группы работали
 * от свежего, и три точки против отставшего считали всё приехавшее в `main`
 * правками групп (481 файл вместо 232, «пересечения» по чужим сервисам).
 * 61c: пересчёт шёл только по концу цепочки — соседи сходились в одном файле, а
 * панель узнавала об этом через час. Подменены только часы.
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

/**
 * Каталог git-процессы отпускают не сразу: на Windows удаление, пришедшее, пока
 * git или антивирус ещё держат файл, отвечает EBUSY — и зелёный тест краснел
 * уборкой.
 */
function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

// Тест под нагрузкой (параллельные прогоны, соседние наборы) упирался в срок
// числом процессов git, а не логикой: исходные репозитории заново собирались
// восемью запусками git перед КАЖДЫМ тестом, и первый тест с push/fetch/двумя
// копиями переваливал за 20 с. Теперь заготовка собирается один раз, а тест
// получает её копию файлами — без единого процесса. Срок набора — с запасом на
// оставшиеся запуски git самих тестов (до 15 на тест).
describe('пересечения веток разделения на настоящем git', { timeout: 60_000 }, () => {
  let template: string;
  let root: string;
  let main: string;
  let seed: string;
  let clock: number;
  let notices: string[];
  let records: Map<string, SplitPlanRecord>;

  beforeAll(() => {
    template = mkdtempSync(join(tmpdir(), 'cc-overlap-tpl-'));
    const origin = join(template, 'origin.git');
    const seedDir = join(template, 'seed');
    git(template, 'init', '-q', '--bare', '-b', 'main', origin);
    git(template, 'clone', '-q', origin, seedDir);
    git(seedDir, 'checkout', '-q', '-b', 'main');
    commit(seedDir, { 'web/a.ts': 'a\n', 'web/b.ts': 'b\n', 'api/x.go': 'x\n' }, 'base');
    git(seedDir, 'push', '-q', 'origin', 'main');
    git(template, 'clone', '-q', origin, join(template, 'main'));
    // Адрес удалённого — относительный: копия заготовки обязана толкать в СВОЙ
    // origin.git, а не в общий у всех тестов.
    git(seedDir, 'remote', 'set-url', 'origin', '../origin.git');
    git(join(template, 'main'), 'remote', 'set-url', 'origin', '../origin.git');
  }, 60_000);

  afterAll(() => {
    removeDir(template);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-overlap-git-'));
    cpSync(template, root, { recursive: true });
    seed = join(root, 'seed');
    main = join(root, 'main');
    clock = Date.parse('2026-09-24T12:00:00.000Z');
    notices = [];
    records = new Map();
  });

  afterEach(() => {
    removeDir(root);
  });

  function overlap(): SplitOverlap {
    return new SplitOverlap({
      git: { mergeBase: readMergeTarget, changedFiles: readBranchFiles, headOf: readWorktreeHead },
      store: {
        get: (parent) => records.get(parent),
        set: (record) => void records.set(record.parentChatId, structuredClone(record)),
        all: () => Object.fromEntries(records),
      },
      emit: (_parent, event: ChatEvent) => {
        notices.push((event as { text: string }).text);
        return true;
      },
      log: () => undefined,
      now: () => new Date(clock),
    });
  }

  /** Копия группы — ветка от `from`, как её завела панель или агент. */
  function group(name: string, from: string): string {
    const path = join(root, `copy-${name}`);
    git(main, 'worktree', 'add', '-q', '-b', name, path, from);
    return path;
  }

  function plan(
    paths: string[],
    status: SplitPlanRecord['groups'][number]['status'] = 'started',
  ): void {
    records.set('родитель', {
      parentChatId: 'родитель',
      projectPath: main,
      createdAt: '2026-09-24T11:00:00.000Z',
      order: paths.map((_, index) => index),
      request: {},
      proposal: {
        groups: paths.map((_, index) => ({
          title: `г${index}`,
          branch: `g${index}`,
          tasks: ['т'],
        })),
      },
      groups: paths.map((path, index) => ({
        index,
        title: `г${index}`,
        branch: `g${index}`,
        after: [],
        status,
        path,
      })),
    });
  }

  it('локальный main отстал — считаем от origin/main: приехавшее в main не правки групп', async () => {
    // В main приехала чужая работа, основная копия её только получила (fetch).
    commit(seed, { 'api/x.go': 'x2\n', 'helm/values.yaml': 'v\n' }, 'upstream');
    git(seed, 'push', '-q', 'origin', 'main');
    git(main, 'fetch', '-q', 'origin');
    expect(await readMergeTarget(main)).toBe('origin/main');

    const g0 = group('g0', 'origin/main');
    const g1 = group('g1', 'origin/main');
    commit(g0, { 'web/a.ts': 'a0\n' }, 'g0');
    commit(g1, { 'web/b.ts': 'b1\n' }, 'g1');
    plan([g0, g1]);

    const view = await overlap().check('родитель');

    expect(view?.unread).toEqual([]);
    expect(view?.counted).toEqual([
      { index: 0, files: 1, names: ['web/a.ts'] },
      { index: 1, files: 1, names: ['web/b.ts'] },
    ]);
    expect(view?.files).toEqual([]);
  });

  it('локальный main впереди удалённого — база он: его коммиты не правки групп', async () => {
    commit(main, { 'docs/local.md': 'l\n' }, 'local, not pushed');
    expect(await readMergeTarget(main)).toBe('main');

    const g0 = group('g0', 'main');
    const g1 = group('g1', 'main');
    commit(g0, { 'web/a.ts': 'a0\n' }, 'g0');
    commit(g1, { 'web/b.ts': 'b1\n' }, 'g1');
    plan([g0, g1]);

    const view = await overlap().check('родитель');
    expect(view?.counted.map((item) => item.names)).toEqual([['web/a.ts'], ['web/b.ts']]);
  });

  it('пересчёт по расписанию ловит схождение соседей, пока они работают', async () => {
    const g0 = group('g0', 'main');
    const g1 = group('g1', 'main');
    commit(g0, { 'web/a.ts': 'a0\n' }, 'g0');
    plan([g0, g1]);
    const watcher = overlap();

    // Первый такт: считали, пересечений нет.
    expect(await watcher.recheckRunning()).toEqual(['родитель']);
    expect(records.get('родитель')?.overlap?.files).toEqual([]);

    // Сосед полез в тот же файл — до конца своей цепочки.
    commit(g1, { 'web/a.ts': 'a1\n' }, 'g1');

    // Срок не вышел — не трогаем: пересчёт стоит git на каждую группу.
    clock += DRIFT_RECHECK_MS - 1_000;
    expect(await watcher.recheckRunning()).toEqual([]);

    clock += 1_000;
    expect(await watcher.recheckRunning()).toEqual(['родитель']);
    expect(records.get('родитель')?.overlap?.files).toEqual([
      { path: 'web/a.ts', groups: [0, 1], outside: [] },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('web/a.ts');
  });

  it('агент завёл ветку под своим именем — сверка идёт по копии, а не по имени из плана', async () => {
    // Живой прогон 25.09.2026: план хранил имя, обрезанное до 100 знаков, а агент
    // группы работал на ветке с полным именем. `база...g0` падал «ambiguous argument».
    const g0 = group('g0-agent-full-name', 'main');
    const g1 = group('g1', 'main');
    commit(g0, { 'web/a.ts': 'a0\n' }, 'g0');
    commit(g1, { 'web/a.ts': 'a1\n' }, 'g1');
    plan([g0, g1]);

    const view = await overlap().check('родитель');

    expect(view?.unread).toEqual([]);
    expect(view?.counted.map((item) => item.names)).toEqual([['web/a.ts'], ['web/a.ts']]);
    expect(view?.files).toEqual([{ path: 'web/a.ts', groups: [0, 1], outside: [] }]);
  });

  it('закрытые разделения по расписанию не пересчитываются', async () => {
    const g0 = group('g0', 'main');
    const g1 = group('g1', 'main');
    plan([g0, g1], 'done');
    expect(await overlap().recheckRunning()).toEqual([]);
    expect(records.get('родитель')?.overlap).toBeUndefined();
  });

  it('такт расписания зовёт пересчёт и не идёт внахлёст; остановка снимает таймер', async () => {
    const g0 = group('g0', 'main');
    const g1 = group('g1', 'main');
    plan([g0, g1]);
    const watcher = overlap();
    const recheck = watcher.recheckRunning.bind(watcher);
    let rechecks = 0;
    let first: Promise<string[]> | undefined;
    watcher.recheckRunning = () => {
      rechecks += 1;
      const pending = recheck();
      first ??= pending;
      return pending;
    };
    let tick: () => void = () => undefined;
    const cleared: unknown[] = [];
    const stop = watcher.watchDrift(1_000, {
      set: (run) => {
        tick = run;
        return 'handle';
      },
      clear: (handle) => void cleared.push(handle),
    });

    tick();
    tick();
    // Ждём сам пересчёт, а не две секунды опроса: под нагрузкой git считал
    // дольше, и тест краснел, не дождавшись верного итога.
    await first;
    expect(records.get('родитель')?.overlap?.at).toBe(new Date(clock).toISOString());
    // Второй такт пришёл, пока первый ещё считал, — пропущен.
    expect(rechecks).toBe(1);
    stop();
    expect(cleared).toEqual(['handle']);
  });
});
