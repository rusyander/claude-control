import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDevLog, DEV_WATCH_LOG } from './dev-restart.mjs';

describe('журнал сторожа dev-сервера', () => {
  it('строка с временем дописывается; переросший предел журнал уходит в .1', () => {
    const appData = join(mkdtempSync(join(tmpdir(), 'dev-log-')), 'data');
    appendDevLog(appData, 'сервер запущен (pid 1, сторож 2)');
    const file = join(appData, DEV_WATCH_LOG);
    expect(readFileSync(file, 'utf8')).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z сервер запущен \(pid 1, сторож 2\)\n$/,
    );

    writeFileSync(file, 'x'.repeat(512 * 1024 + 1));
    appendDevLog(appData, 'перезапуск: src/index.ts');
    expect(readFileSync(`${file}.1`, 'utf8')).toHaveLength(512 * 1024 + 1);
    expect(readFileSync(file, 'utf8')).toMatch(/^\S+ перезапуск: src\/index\.ts\n$/);
  });

  it('ровно на пределе журнал не ротируется', () => {
    const appData = mkdtempSync(join(tmpdir(), 'dev-log-'));
    const file = join(appData, DEV_WATCH_LOG);
    writeFileSync(file, 'x'.repeat(512 * 1024));
    appendDevLog(appData, 'строка');
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toMatch(/строка\n$/);
  });
});
