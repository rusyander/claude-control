import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepAbandonedSandboxes } from './SandboxConfig.ts';

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
    const removed = sweepAbandonedSandboxes(Date.now(), root);

    expect(removed).toContain('broshennaya');
    expect(existsSync(abandoned)).toBe(false);
  });

  it('свежую песочницу не трогает: рядом мог стартовать второй сервер', () => {
    sweepAbandonedSandboxes(Date.now(), root);

    expect(existsSync(fresh)).toBe(true);
  });

  it('на пустом месте не падает', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cc-sweep-empty-'));

    expect(sweepAbandonedSandboxes(Date.now(), empty)).toEqual([]);

    rmSync(empty, { recursive: true, force: true });
  });

  it('несуществующий корень не падает', () => {
    expect(sweepAbandonedSandboxes(Date.now(), join(root, 'нет-такого'))).toEqual([]);
  });

  it('момент отсчёта можно сдвинуть: тогда и свежая папка считается брошенной', () => {
    const removed = sweepAbandonedSandboxes(Date.now() + hour, root);

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
