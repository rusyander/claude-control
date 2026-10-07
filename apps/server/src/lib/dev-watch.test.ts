import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECK_LEDGERS,
  SourceWatcher,
  busyRun,
  isWatched,
  splitSetupRunning,
} from './dev-watch.mjs';
import {
  E2E_RUN_PROCESS_LEDGER,
  MUTATION_PROCESS_LEDGER,
  PROJECT_TEST_PROCESS_LEDGER,
} from '../domains/project-tests/runs.ts';
import {
  deferReason,
  readRestartState,
  requestRestart,
  takeRestartRequest,
  writeRestartState,
} from './dev-restart.mjs';

/**
 * Dev-сторож сервера на настоящей файловой системе и настоящем `fs.watch`.
 *
 * Ради чего: `node --watch` перезапускал панель от одного сдвига времени
 * доступа у файла из графа импортов (замер 25.09: `utimes` только atime у
 * импортируемого модуля → «Restarting 'main.mjs'»). Сторож обязан отличать
 * чтение от правки.
 */

let dir: string;
let watcher: SourceWatcher | undefined;

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startIn(): string[][] {
  dir = mkdtempSync(join(tmpdir(), 'dev-watch-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'brand.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'lib', 'brand.test.ts'), '// тест\n');
  // Круглое время записи: `utimes` ниже иначе обрезал бы его до миллисекунд —
  // и тест сам сделал бы ту правку, которой быть не должно.
  const round = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  utimesSync(join(dir, 'lib', 'brand.mjs'), round, round);
  const batches: string[][] = [];
  watcher = new SourceWatcher([dir], (files) => batches.push(files), 50).start();
  return batches;
}

describe('dev-сторож сервера', () => {
  it('чтение и сдвиг времени доступа — не правка, перезапуска нет', async () => {
    const batches = startIn();
    const file = join(dir, 'lib', 'brand.mjs');
    readFileSync(file, 'utf8');
    const { mtime } = statSync(file);
    // Ровно то, что делает NTFS раз в час, когда сторож панели импортирует brand.mjs.
    utimesSync(file, new Date(Date.now() + 3_600_000), mtime);
    await pause(600);
    expect(batches).toEqual([]);
  });

  it('настоящая правка — одна пачка на серию записей', async () => {
    const batches = startIn();
    const file = join(dir, 'lib', 'brand.mjs');
    writeFileSync(file, 'export const x = 2;\n');
    writeFileSync(file, 'export const x = 22;\n');
    await pause(600);
    expect(batches).toEqual([[file]]);
  });

  it('правка теста или заметки сервер не перезапускает', async () => {
    const batches = startIn();
    writeFileSync(join(dir, 'lib', 'brand.test.ts'), '// другой тест\n');
    writeFileSync(join(dir, 'lib', 'NOTES.md'), '# заметка\n');
    await pause(600);
    expect(batches).toEqual([]);
  });

  it('что считается кодом сервера', () => {
    expect(isWatched('/s/src/domains/chat/ChatRunner.ts')).toBe(true);
    expect(isWatched('/s/src/lib/brand.mjs')).toBe(true);
    expect(isWatched('/s/src/domains/chat/ChatRunner.test.ts')).toBe(false);
    expect(isWatched('/s/src/domains/chat/__fixtures__/fake.mjs')).toBe(false);
    expect(isWatched('/s/src/lib/brand.d.mts')).toBe(false);
    expect(isWatched('/s/src/bootstrap/server-ru-literals.pins.json')).toBe(false);
    expect(isWatched('/s/README.md')).toBe(false);
  });

  it('перезапуск ждёт идущего хода, но не ждущей сессии и не мёртвого процесса', () => {
    const alive = (pid: number) => pid === 10;
    expect(busyRun([{ key: 'a', pid: 10 }], alive)).toBe(true);
    expect(busyRun([{ key: 'a', pid: 10, idle: true }], alive)).toBe(false);
    expect(busyRun([{ key: 'a', pid: 11 }], alive)).toBe(false);
    expect(busyRun([{ key: 'a' }], alive)).toBe(false);
  });

  // Живой прогон 29.09, 07:37: правка сервера перезапустила панель посреди
  // `npm ci` четырёх групп — прогонов в журнале ещё не было, и ждать было нечего.
  it('подготовка копии группы разделения — тоже идущая работа', () => {
    const now = Date.parse('2026-09-29T07:40:00.000Z');
    const plan = (group: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      splitPlans: { p: { parentChatId: 'p', groups: [{ index: 0, ...group }], ...extra } },
    });
    const setup = { status: 'started', startedAt: '2026-09-29T07:37:44.000Z' };
    expect(splitSetupRunning(plan(setup), now)).toBe(true);
    // Чат уже есть — дальше решает журнал прогонов.
    expect(splitSetupRunning(plan({ ...setup, chatId: 'new-1-0' }), now)).toBe(false);
    expect(splitSetupRunning(plan({ ...setup, status: 'paused' }), now)).toBe(false);
    expect(splitSetupRunning(plan(setup, { cancelledAt: '2026-09-29T07:38:00.000Z' }), now)).toBe(
      false,
    );
    // Застрявшая запись (процесс умер, перезапуска не было) не держит вечно.
    expect(splitSetupRunning(plan(setup), now + 60 * 60_000)).toBe(false);
    expect(splitSetupRunning({}, now)).toBe(false);
    expect(splitSetupRunning(null, now)).toBe(false);
  });
});

// Решение 30.09: перезапуск ждёт живые ходы без предела, панель видит ожидание.
describe('отложенный перезапуск — общий файл сторожа и сервера', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('чего ждёт: ходов, копий, обоих — или ничего', () => {
    expect(deferReason(true, false)).toBe('runs');
    expect(deferReason(false, true)).toBe('setup');
    expect(deferReason(true, true)).toBe('both');
    expect(deferReason(false, false)).toBeUndefined();
  });

  // Ф11: автотесты и проверка поломкой — тоже повод ждать; несколько поводов — `both`.
  it('проверки проекта: свой повод, вместе с другими — «несколько»', () => {
    expect(deferReason(false, false, true)).toBe('checks');
    expect(deferReason(true, false, true)).toBe('both');
    expect(deferReason(false, true, true)).toBe('both');
  });

  it('сторож читает те же журналы процессов, что пишут прогоны проверок', () => {
    expect([...CHECK_LEDGERS].sort()).toEqual(
      [E2E_RUN_PROCESS_LEDGER, PROJECT_TEST_PROCESS_LEDGER, MUTATION_PROCESS_LEDGER].sort(),
    );
  });

  it('состояние живого сторожа видно, оставшееся от мёртвого — нет', () => {
    dir = mkdtempSync(join(tmpdir(), 'dev-restart-'));
    expect(readRestartState(dir)).toEqual({ pending: false });
    writeRestartState(dir, {
      pid: 42,
      since: '2026-09-30T10:00:00.000Z',
      files: ['apps/server/src/index.ts'],
      waitingFor: 'setup',
    });
    expect(readRestartState(dir, (pid) => pid === 42)).toEqual({
      pending: true,
      since: '2026-09-30T10:00:00.000Z',
      files: ['apps/server/src/index.ts'],
      waitingFor: 'setup',
      requested: false,
    });
    expect(readRestartState(dir, () => false)).toEqual({ pending: false });
  });

  it('запрос «перезапустить сейчас» виден и забирается один раз', () => {
    dir = mkdtempSync(join(tmpdir(), 'dev-restart-'));
    writeRestartState(dir, { pid: 1, since: 'x', files: [], waitingFor: 'runs' });
    requestRestart(dir);
    expect(readRestartState(dir, () => true).requested).toBe(true);
    expect(takeRestartRequest(dir)).toBe(true);
    expect(takeRestartRequest(dir)).toBe(false);
    expect(readRestartState(dir, () => true).requested).toBe(false);
  });
});
