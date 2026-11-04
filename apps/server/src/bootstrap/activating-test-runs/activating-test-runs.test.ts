import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from '../../domains/project-tests/store/store.ts';
import {
  fakeCorePort,
  waitFor,
} from '../../domains/project-tests/agent/__fixtures__/fake-core-port.ts';
import { ActivatingTestRunRegistry } from './activating-test-runs.ts';

/**
 * Реестр стенда включает переходник MCP и обязан передать заявку дальше
 * ЦЕЛИКОМ: прежняя перегрузка звала `super.start(request, now)`, и материал
 * генерации («по требованию»), доступы стенда и выбор папки e2e на стенде
 * терялись, хотя в тестах голого реестра всё доходило. Прогон идёт задачей ядра
 * (этап 10): подменена только граница процесса ядра.
 */
describe('bootstrap/activating-test-runs', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-activating-runs-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, '2026-09-28T00:00:00.000Z');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('включает переходник и передаёт материал и доступы стенда в задачу ядра', async () => {
    const core = fakeCorePort({ hold: true });
    const activated: string[] = [];
    const registry = new ActivatingTestRunRegistry((path) => activated.push(path));
    registry.setCorePort(core.port);

    registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui', source: 'requirement' },
      '2026-09-28T00:00:00.000Z',
      {
        source: 'requirement',
        requirement: { key: 'QA-42', url: 'https://tracker.example.com/QA-42', title: 'Вход' },
      },
      () => ({ values: { STAND_TOKEN: 'tok-123', NODE_OPTIONS: '--inspect' }, missing: [] }),
    );
    await waitFor(() => core.estimates.length > 0);
    const log = registry.get(root)!.log;
    registry.stop(root);

    expect(activated).toEqual([root]);
    expect(core.estimates[0]!.request).toContain('REQUIREMENT QA-42');
    // Доступы дошли сквозь перегрузку: значение — окружением задачи ядра (телом рядом с оценкой),
    // имя — в полях оценки; имя, которое ядро держит само, названо в логе. Этап 10: прежний
    // «в задачу ядра значение не уходит» снят, когда ядро стало держать окружение задачи.
    expect(core.envs[0]).toEqual({ STAND_TOKEN: 'tok-123' });
    expect(core.estimates[0]!.session?.env).toEqual(['STAND_TOKEN']);
    expect(JSON.stringify(core.estimates)).not.toContain('tok-123');
    expect(log).toContain('переменная NODE_OPTIONS в прогон не передана');
    expect(log).not.toContain('tok-123');
  });
});
