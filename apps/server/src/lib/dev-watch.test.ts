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
import { SourceWatcher, busyRun, isWatched } from './dev-watch.mjs';

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
});
