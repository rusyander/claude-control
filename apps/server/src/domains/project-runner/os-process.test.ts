import { afterEach, describe, expect, it } from 'vitest';
import { openBrowser } from './os-process.ts';

/**
 * Открытие браузера ОС на машине без открывалки (Linux-сервер без xdg-open,
 * контейнер): настоящий spawn с пустым PATH. На Windows не запускается —
 * `cmd start` при найденном cmd открыл бы окно на рабочем столе человека.
 */
describe.skipIf(process.platform === 'win32')('openBrowser без открывалки в PATH', () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  it('ENOENT не роняет процесс сервера', async () => {
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on('uncaughtException', onCrash);
    try {
      process.env.PATH = '';
      openBrowser('http://127.0.0.1:1/');
      await new Promise((done) => setTimeout(done, 300));
    } finally {
      process.off('uncaughtException', onCrash);
    }
    expect(crashes).toEqual([]);
  });
});
