import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDevLog, appendServerLog, DEV_WATCH_LOG, SERVER_LOG } from './dev-restart.mjs';

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

/**
 * Поток ошибок сервера в `server.log` (журнал 26.10, #g8:30): keepalive берёт у
 * сторожа лишь первые строки, stdout выбрасывает — предупреждения панели не
 * оседали нигде. Кусок потока — построчно с отметкой времени, пустые строки не
 * пишутся, переросший 2 МБ журнал уходит в `.1`, сбой записи сторожа не роняет.
 */
describe('журнал потока ошибок сервера', () => {
  const STAMPED = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

  it('кусок с несколькими строками — по строке на запись, у каждой время; пустые выброшены', () => {
    const appData = join(mkdtempSync(join(tmpdir(), 'server-log-')), 'data');
    appendServerLog(
      appData,
      'permission-request: Bash toolu_1 answered in 131 s\r\n\n   \nвторая строка\n',
    );
    appendServerLog(appData, Buffer.from('третья\n'));
    const lines = readFileSync(join(appData, SERVER_LOG), 'utf8').split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    for (const line of lines.slice(0, 3)) expect(line).toMatch(STAMPED);
    expect(lines.slice(0, 3).map((line) => line.replace(STAMPED, ''))).toEqual([
      'permission-request: Bash toolu_1 answered in 131 s',
      'вторая строка',
      'третья',
    ]);
  });

  it('кусок из одних пустых строк файла не заводит', () => {
    const appData = mkdtempSync(join(tmpdir(), 'server-log-'));
    appendServerLog(appData, '\n  \r\n');
    expect(existsSync(join(appData, SERVER_LOG))).toBe(false);
  });

  it('больше 2 МБ — прежний журнал уходит в .1; ровно на пределе — остаётся', () => {
    const appData = mkdtempSync(join(tmpdir(), 'server-log-'));
    const file = join(appData, SERVER_LOG);
    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024));
    appendServerLog(appData, 'на пределе');
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toMatch(/ на пределе\n$/);

    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
    appendServerLog(appData, 'после ротации');
    expect(readFileSync(`${file}.1`, 'utf8')).toHaveLength(2 * 1024 * 1024 + 1);
    expect(readFileSync(file, 'utf8')).toMatch(/^\S+ после ротации\n$/);
  });

  it('каталог не записать (на его месте файл) — тихо, без исключения', () => {
    const parent = mkdtempSync(join(tmpdir(), 'server-log-'));
    const blocked = join(parent, 'data');
    writeFileSync(blocked, 'не каталог');
    expect(() => appendServerLog(blocked, 'строка')).not.toThrow();
    expect(readFileSync(blocked, 'utf8')).toBe('не каталог');
  });
});
