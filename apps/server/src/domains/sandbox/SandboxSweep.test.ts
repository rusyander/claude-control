import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSandboxExpired,
  markSandboxBusy,
  markSandboxFree,
  startSandboxHousekeeping,
  sweepAbandonedSandboxes,
  sweepDeferredSandboxes,
  sweepIdleSandboxes,
  startSandboxSweeper,
  stopSandboxSweeper,
} from './SandboxConfig.ts';

/**
 * В песочнице лежит копия .credentials.json и значения env MCP-серверов
 * открытым текстом. Штатно она стирается при закрытии, но после аварийного
 * завершения папка оставалась на диске, и README предлагал удалить её руками.
 *
 * Реестр песочниц живёт только в памяти сервера, поэтому всё, что лежит на
 * диске к моменту старта, — заведомо брошенное.
 *
 * Корень передаётся параметром: тест не должен трогать настоящие песочницы
 * (там чужие данные) и не должен конкурировать с соседними тестами за общий
 * каталог.
 */
describe('sweepAbandonedSandboxes', () => {
  let root: string;
  let abandoned: string;
  let fresh: string;

  const hour = 60 * 60 * 1000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-sweep-'));
    abandoned = join(root, 'broshennaya');
    fresh = join(root, 'svezhaya');

    mkdirSync(join(abandoned, 'config'), { recursive: true });
    writeFileSync(join(abandoned, 'config', '.credentials.json'), '{"token":"пример"}');
    mkdirSync(fresh, { recursive: true });

    // Состариваем одну из папок: подметание щадит свежие.
    const old = new Date(Date.now() - hour);
    utimesSync(abandoned, old, old);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('удаляет брошенную песочницу вместе с копией учётных данных', () => {
    const { removed } = sweepAbandonedSandboxes(Date.now(), root);

    expect(removed).toContain('broshennaya');
    expect(existsSync(abandoned)).toBe(false);
  });

  it('свежую песочницу не трогает: рядом мог стартовать второй сервер', () => {
    sweepAbandonedSandboxes(Date.now(), root);

    expect(existsSync(fresh)).toBe(true);
  });

  it('на пустом месте не падает', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cc-sweep-empty-'));

    expect(sweepAbandonedSandboxes(Date.now(), empty).removed).toEqual([]);

    rmSync(empty, { recursive: true, force: true });
  });

  it('несуществующий корень не падает', () => {
    expect(sweepAbandonedSandboxes(Date.now(), join(root, 'нет-такого')).removed).toEqual([]);
  });

  it('момент отсчёта можно сдвинуть: тогда и свежая папка считается брошенной', () => {
    const { removed } = sweepAbandonedSandboxes(Date.now() + hour, root);

    expect(removed.sort()).toEqual(['broshennaya', 'svezhaya']);
    expect(existsSync(fresh)).toBe(false);
  });

  it('файлы в корне пропускаются: удаляем только папки песочниц', () => {
    const stray = join(root, 'заметка.txt');
    writeFileSync(stray, 'не песочница');
    const old = new Date(Date.now() - hour);
    utimesSync(stray, old, old);

    sweepAbandonedSandboxes(Date.now(), root);

    expect(existsSync(stray)).toBe(true);
  });
});

/**
 * Подметание по простою — то, чего не хватало на работающем сервере.
 *
 * Песочница удалялась только из размонтирования модалки (DELETE) и при СТАРТЕ
 * сервера. Закрытая вкладка, F5 или падение браузера DELETE не шлют, а панель
 * работает сутками — копия `.credentials.json` лежала на диске всё это время,
 * хотя интерфейс обещает «всё созданное стирается при закрытии окна».
 */
describe('sweepIdleSandboxes', () => {
  let root: string;
  const hour = 60 * 60 * 1000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-idle-'));
  });

  afterEach(() => {
    stopSandboxSweeper();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  /** Песочница с копией доступа внутри; возраст задаётся отдельно каждому файлу. */
  function makeSandbox(name: string, ageMs: number): string {
    const dir = join(root, name);
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', '.credentials.json'), '{"token":"пример"}');

    const stamp = new Date(Date.now() - ageMs);
    for (const path of [join(dir, 'config', '.credentials.json'), join(dir, 'config'), dir]) {
      utimesSync(path, stamp, stamp);
    }
    return dir;
  }

  it('брошенная песочница со временем исчезает вместе с копией доступа', () => {
    const dir = makeSandbox('брошенная', 3 * hour);

    expect(sweepIdleSandboxes(Date.now(), root, hour).removed).toContain('брошенная');
    expect(existsSync(dir)).toBe(false);
  });

  it('свежая запись ВНУТРИ песочницы спасает её от удаления', () => {
    // Ключевое отличие от стартового подметания: mtime самой папки не меняется
    // от записи вглубь, поэтому по нему живой разговор выглядел бы брошенным.
    const dir = makeSandbox('живая', 3 * hour);
    writeFileSync(join(dir, 'config', 'свежий.jsonl'), 'запись');

    expect(sweepIdleSandboxes(Date.now(), root, hour).removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('несуществующий корень не падает', () => {
    expect(sweepIdleSandboxes(Date.now(), join(root, 'нет-такого'), hour).removed).toEqual([]);
  });

  it('подметальщик работает по таймеру, а не один раз на старте сервера', () => {
    vi.useFakeTimers();
    const dir = makeSandbox('брошенная', 3 * hour);

    startSandboxSweeper({ intervalMs: 1000, idleMs: hour, root });
    expect(existsSync(dir)).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(existsSync(dir)).toBe(false);
  });

  it('остановленный подметальщик больше не тикает', () => {
    vi.useFakeTimers();
    const stop = startSandboxSweeper({ intervalMs: 1000, idleMs: hour, root });
    stop();

    const dir = makeSandbox('брошенная', 3 * hour);
    vi.advanceTimersByTime(10_000);

    expect(existsSync(dir)).toBe(true);
  });
});

/**
 * Подметание против живого прогона и жизнь песочницы после уборки.
 *
 * Свежесть по отметкам файлов — признак приблизительный: длинный агентный ход
 * может часами ничего не писать, а сервер при этом точно знает, что внутри
 * работает CLI. И наоборот: если песочницу всё же унесло, следующий прогон
 * должен об этом СКАЗАТЬ, а не собрать на её месте пустую.
 */
describe('подметание и состояние песочницы', () => {
  let root: string;
  const hour = 60 * 60 * 1000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-busy-'));
  });

  afterEach(() => {
    stopSandboxSweeper();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  /** Имя латиницей: оно же служит ключом реестров (см. sandboxKey). */
  function makeSandbox(name: string, ageMs: number): string {
    const dir = join(root, name);
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', '.credentials.json'), '{"token":"пример"}');

    const stamp = new Date(Date.now() - ageMs);
    for (const path of [join(dir, 'config', '.credentials.json'), join(dir, 'config'), dir]) {
      utimesSync(path, stamp, stamp);
    }
    return dir;
  }

  it('песочницу с живым прогоном не сносит, сколько бы она ни молчала', () => {
    const dir = makeSandbox('qa-busy', 3 * hour);
    markSandboxBusy('qa-busy');

    expect(sweepIdleSandboxes(Date.now(), root, hour).removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);

    // Прогон закончился — защита снимается, и обычные правила снова в силе.
    markSandboxFree('qa-busy');
    expect(sweepIdleSandboxes(Date.now(), root, hour).removed).toEqual(['qa-busy']);
    expect(existsSync(dir)).toBe(false);
  });

  it('унесённая подметанием песочница помечена истёкшей: подменять её пустой нельзя', () => {
    makeSandbox('qa-expired', 3 * hour);
    expect(isSandboxExpired('qa-expired')).toBe(false);

    sweepIdleSandboxes(Date.now(), root, hour);

    expect(isSandboxExpired('qa-expired')).toBe(true);
  });

  it('отложенный проход убирает то, что пощадила пауза на старте', () => {
    const dir = makeSandbox('qa-deferred', hour);

    expect(sweepDeferredSandboxes(['qa-deferred'], Date.now(), root).removed).toEqual([
      'qa-deferred',
    ]);
    expect(existsSync(dir)).toBe(false);
  });

  it('отложенный проход щадит песочницу, в которой писали после старта сервера', () => {
    // Так отсеиваются и соседний сервер, и песочница, созданная этим сервером
    // уже после запуска: у обеих отметки новее момента старта.
    const dir = makeSandbox('qa-live', 0);

    expect(sweepDeferredSandboxes(['qa-live'], Date.now() - hour, root).removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('уборка на старте взводит подметание, а не проходит по диску единожды', () => {
    // Раньше таймер заводило только создание песочницы: в сеансе, где модалку не
    // открывали, брошенная копия доступа лежала до следующего перезапуска.
    vi.useFakeTimers();
    startSandboxHousekeeping({ root, now: Date.now(), graceMs: 60_000, intervalMs: 1000, idleMs: hour });

    // Песочница появилась уже после старта — стартовый проход её не видел.
    const dir = makeSandbox('qa-later', 3 * hour);
    expect(existsSync(dir)).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(existsSync(dir)).toBe(false);
  });

  it('пощажённую паузой песочницу добирает отложенный проход, а не следующий перезапуск', () => {
    vi.useFakeTimers();
    const dir = makeSandbox('qa-spared', 5_000);

    const report = startSandboxHousekeeping({
      root,
      now: Date.now(),
      graceMs: 30_000,
      intervalMs: 10 * hour,
      idleMs: hour,
    });

    expect(report.deferred).toEqual(['qa-spared']);
    expect(existsSync(dir)).toBe(true);

    vi.advanceTimersByTime(30_000);
    expect(existsSync(dir)).toBe(false);
  });

  it('остановка уборки гасит и отложенный проход', () => {
    vi.useFakeTimers();
    const dir = makeSandbox('qa-spared', 5_000);

    startSandboxHousekeeping({
      root,
      now: Date.now(),
      graceMs: 30_000,
      intervalMs: 10 * hour,
      idleMs: hour,
    }).stop();

    vi.advanceTimersByTime(60_000);
    expect(existsSync(dir)).toBe(true);
  });
});
