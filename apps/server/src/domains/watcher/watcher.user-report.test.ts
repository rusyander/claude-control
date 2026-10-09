import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPidAlive } from '../chat/run-ledger/run-ledger.ts';
import { sectionsOf } from './report.ts';
import { BackgroundWatcher } from './watcher.ts';
import type { WatchSignal } from './types.ts';

/**
 * Баг, присланный человеком из окна наблюдателя, на НАСТОЯЩЕМ процессе разбора
 * (фальшивый CLI `__fixtures__/fake-claude.mjs` отвечает вердиктом из
 * `fake-config.json`). Обещание человеку: в отчёт попадает только то, что
 * модель подтвердила по коду, и исход каждой проверки виден в статусе.
 */
const FAKE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));

const signal500: WatchSignal = {
  source: 'server',
  kind: 'http-5xx',
  method: 'GET',
  path: '/api/chats',
  status: 500,
  message: 'Cannot read properties of undefined',
};

describe('баг словами человека', () => {
  let appData: string;
  let cwd: string;
  let report: string;
  const watchers: BackgroundWatcher[] = [];
  const spawned: ChildProcess[] = [];

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-watch-user-data-'));
    cwd = mkdtempSync(join(tmpdir(), 'cc-watch-user-cwd-'));
    report = join(cwd, 'WATCH-REPORT.md');
  });
  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.shutdown();
    for (const child of spawned.splice(0)) if (child.pid && isPidAlive(child.pid)) child.kill();
    rmSync(appData, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const make = (): BackgroundWatcher => {
    const watcher = new BackgroundWatcher({
      appDataDir: () => appData,
      reportPath: () => report,
      cwd,
      resolveCommand: () => process.execPath,
      model: () => 'haiku',
      pricing: () => ({}),
      spawnImpl: ((command: string, args: string[], options: object) => {
        const child = spawn(command, [FAKE, ...args], options);
        spawned.push(child);
        return child;
      }) as never,
      debounceMs: 10,
    });
    watchers.push(watcher);
    return watcher;
  };
  const fake = (config: object): void =>
    writeFileSync(join(cwd, 'fake-config.json'), JSON.stringify(config));
  const prompt = (): string =>
    (JSON.parse(readFileSync(join(cwd, 'fake-argv.json'), 'utf8')) as { prompt: string }).prompt;
  const sections = () =>
    existsSync(report) ? [...sectionsOf(readFileSync(report, 'utf8')).values()] : [];

  it('выключен — проверки нет', () => {
    expect(make().reportBug({ text: 'Кнопка не работает' })).toBeUndefined();
  });

  it('подтверждён — раздел в отчёте с номером, проверка «подтверждён» с этим номером', async () => {
    const watcher = make();
    watcher.setEnabled(true);
    const check = watcher.reportBug({
      text: 'После «Принять» карточка не меняется',
      route: '/chat',
    });
    expect(check).toMatchObject({ state: 'checking', route: '/chat' });
    // До вердикта — ни строчки в отчёте.
    expect(sections()).toEqual([]);

    await watcher.settled();
    expect(prompt()).toContain('kind: user-report');
    expect(prompt()).toContain('После «Принять» карточка не меняется');
    expect(sections().map((s) => [s.ref, s.verdict])).toEqual([['WR-1', 'confirmed']]);
    expect(readFileSync(report, 'utf8')).toContain('описание бага (человек)');
    expect(watcher.status().checks?.[0]).toMatchObject({
      state: 'confirmed',
      ref: 'WR-1',
      title: `Находка ${check?.id}`,
    });
    expect(watcher.status().pending).toBe(0);
  });

  it('не подтверждён — отчёта нет, запись убрана, причина модели в проверке', async () => {
    fake({ verdict: 'not-in-code', happened: 'Карточка меняет фон через hubBucket.' });
    const watcher = make();
    watcher.setEnabled(true);
    watcher.reportBug({ text: 'Карточка не меняется' });
    await watcher.settled();
    expect(sections()).toEqual([]);
    expect(watcher.events.list()).toEqual([]);
    expect(watcher.status().checks?.[0]).toMatchObject({
      state: 'rejected',
      reason: 'Карточка меняет фон через hubBucket.',
    });
  });

  it('модель не решила — «неясно», в отчёт не идёт', async () => {
    fake({ verdict: 'unclear' });
    const watcher = make();
    watcher.setEnabled(true);
    watcher.reportBug({ text: 'Что-то странное в чате' });
    await watcher.settled();
    expect(sections()).toEqual([]);
    expect(watcher.status().checks?.[0]?.state).toBe('unclear');
  });

  it('разбор упал — «не удалось» с причиной, запись ждёт следующего разбора', async () => {
    fake({ fail: true });
    const watcher = make();
    watcher.setEnabled(true);
    watcher.reportBug({ text: 'Падает страница тестов' });
    await watcher.settled();
    expect(watcher.status().checks?.[0]).toMatchObject({ state: 'failed', reason: 'fake failure' });
    expect(watcher.status().pending).toBe(1);
  });

  it('подтверждён как та же причина — номер раздела, куда влит', async () => {
    fake({ mergeIntoFirst: true });
    const watcher = make();
    watcher.setEnabled(true);
    watcher.signal(signal500);
    watcher.reportBug({ text: 'Список чатов не грузится' });
    await watcher.settled();
    expect(sections().map((s) => [s.ref, s.count])).toEqual([['WR-1', 2]]);
    expect(watcher.status().checks?.[0]).toMatchObject({ state: 'confirmed', ref: 'WR-1' });
  });

  it('не подтверждён, хоть модель и назвала «той же причиной» — чужой раздел не растёт', async () => {
    fake({ mergeIntoFirst: true, verdict: 'not-in-code' });
    const watcher = make();
    watcher.setEnabled(true);
    watcher.signal(signal500);
    watcher.reportBug({ text: 'Список чатов не грузится' });
    await watcher.settled();
    expect(sections().map((s) => [s.ref, s.count])).toEqual([['WR-1', 1]]);
    expect(watcher.status().checks?.[0]?.state).toBe('rejected');
  });

  it('проверок в статусе — не больше десяти, свежие первыми', () => {
    const watcher = make();
    watcher.setEnabled(true);
    // Цифры отпечаток выбрасывает — различаются слова.
    const words = 'альфа бета гамма дельта эпсилон дзета эта тета йота каппа лямбда мю'.split(' ');
    for (const word of words) watcher.reportBug({ text: `Ломается раздел ${word}` });
    const checks = watcher.status().checks ?? [];
    expect(checks).toHaveLength(10);
    expect(checks[0]?.text).toBe('Ломается раздел мю');
  });
});
