import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keepPreviousLog } from './server.ts';

/**
 * Журнал сервера моделей переживает один перезапуск (L6): скрытый запуск на Windows пишет
 * его заново, и подъём после зависания стирал ровно то, что объясняло зависание.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-prev-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('журнал прошлого запуска', () => {
  it('переезжает в .prev.log и заменяет прежний прошлый; новый запуск начинает с чистого', () => {
    const log = join(dir, 'llama.log');
    writeFileSync(join(dir, 'llama.prev.log'), 'позапрошлый');
    writeFileSync(log, 'зависание в 14:27');
    keepPreviousLog(log);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(join(dir, 'llama.prev.log'), 'utf8')).toBe('зависание в 14:27');
  });

  it('пустого или отсутствующего журнала не трогает: прошлый остаётся прежним', () => {
    const log = join(dir, 'llama.log');
    writeFileSync(join(dir, 'llama.prev.log'), 'улика');
    keepPreviousLog(log);
    writeFileSync(log, '');
    keepPreviousLog(log);
    expect(readFileSync(join(dir, 'llama.prev.log'), 'utf8')).toBe('улика');
  });
});
