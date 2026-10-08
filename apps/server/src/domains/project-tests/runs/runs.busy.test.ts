import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun } from '../../chat/ChatRunner/ChatRunner.ts';
import { ProjectTestsLockedError } from '../files.ts';
import { ProjectTestRunRegistry } from './runs.ts';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Второй запуск, пока первый идёт, — конфликт, а не кривой запрос.
 *
 * Живой прогон 26.09: вторая генерация по тому же проекту (путь в другом
 * написании) получала 400 — тот же код, что у пустого тела. Клиент не мог
 * отличить «уже идёт, открой его» от «ты прислал ерунду». Замок группы уже
 * отвечает 409 с id прогона; отказ «уже идёт» — тот же случай.
 */
describe('project-tests/runs: второй запуск', () => {
  let root = '';
  const registry = new ProjectTestRunRegistry();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-busy-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, '2026-09-26T00:00:00.000Z');
  });

  afterEach(() => {
    registry.stop(root);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('пока идёт прогон — 409 с id идущего', async () => {
    const start = vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);
    const first = registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    let refusal: unknown;
    try {
      registry.start(
        { projectPath: root, mode: 'run', groupId: 'gui' },
        '2026-09-26T00:00:01.000Z',
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProjectTestsLockedError);
    expect(refusal).toMatchObject({
      statusCode: 409,
      runId: first.id,
      messageCode: 'run-already-running',
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  /**
   * F-160. Генерации с e2e маршрут заводил папку ДО старта, и отказ «уже идёт»
   * оставлял её на диске. Теперь папку заводит реестр после своих отказов.
   */
  it('отказанный старт генерации с e2e папку не заводит, принятый — заводит', async () => {
    const start = vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);
    registry.start({ projectPath: root, mode: 'run', groupId: 'gui' }, '2026-09-26T00:00:00.000Z');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const ensured: string[] = [];
    const ensureE2e = (): void => {
      ensured.push(root);
    };
    expect(() =>
      registry.start(
        { projectPath: root, mode: 'generate', groupId: 'gui', e2e: true },
        '2026-09-26T00:00:01.000Z',
        undefined,
        undefined,
        { ensureE2e },
      ),
    ).toThrow(ProjectTestsLockedError);
    expect(ensured).toEqual([]);

    registry.stop(root);
    await vi.waitFor(() => expect(registry.get(root)?.status).not.toBe('running'));
    registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui', e2e: true },
      '2026-09-26T00:00:02.000Z',
      undefined,
      undefined,
      { ensureE2e },
    );
    expect(ensured).toEqual([root]);
  });

  /**
   * Реестр держит проект путём «как на диске» (маршрут приводит к нему), а
   * наблюдатель папки e2e и конец хода чата спрашивают путём «как ввели» —
   * реестр проектов стенда хранит `c:\work\…`. Точный `Map.get` их не видел.
   */
  it('замок виден и по другому написанию того же пути', async () => {
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);
    const first = registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
    );
    const spellings = [root.replace(/\\/g, '/')];
    if (process.platform === 'win32') {
      spellings.push(root.charAt(0).toLowerCase() + root.slice(1), root.toUpperCase());
    }
    for (const spelled of spellings) {
      expect(registry.holds(spelled)).toBe(first.id);
      expect(registry.get(spelled)?.id).toBe(first.id);
    }
    expect(registry.holds(`${root}-other`)).toBeUndefined();
  });

  /**
   * Запуск ждёт приёмник прав и только потом стартует CLI. «Стоп» в эту паузу
   * закрывал прогон, а запуск всё равно стартовал: настоящий `claude -p` жил
   * без хозяина (его уже никто не останавливал), а приёмник прав — открытым
   * портом. Так обычный прогон набора оставлял живые процессы CLI.
   */
  it('остановленный до старта CLI прогон CLI не запускает', async () => {
    const start = vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);
    registry.start({ projectPath: root, mode: 'run', groupId: 'gui' }, '2026-09-26T00:00:00.000Z');
    expect(registry.stop(root)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(start).not.toHaveBeenCalled();
    expect(registry.get(root)?.status).toBe('stopped');
  });
});
