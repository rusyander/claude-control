import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun } from '../chat/ChatRunner.ts';
import { ProjectTestRunRegistry } from './runs.ts';
import { createGroup, upsertCase } from './store.ts';

/**
 * F-138. Имя сессии прогона видно в списке разговоров рядом с остальным
 * интерфейсом — и было русским при английской панели. Реестр берёт язык панели
 * так же, как маршрут контура: геттером, заданным при сборке.
 */
describe('project-tests/runs: имя сессии на языке панели', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-lang-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, '2026-09-26T00:00:00.000Z');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each([
    ['en', 'Tests: generation — '],
    ['ru', 'Тесты: генерация — '],
  ] as const)('панель %s — имя «%s…»', async (lang, prefix) => {
    const registry = new ProjectTestRunRegistry();
    registry.setLanguage(() => lang);
    const start = vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);
    registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[0].name).toMatch(new RegExp(`^${prefix}`));
    registry.stop(root);
  });
});
