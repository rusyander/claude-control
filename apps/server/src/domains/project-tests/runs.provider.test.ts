import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun } from '../chat/ChatRunner.ts';
import { defaultCliCommand } from '../../providers/cli.ts';
import { ProjectTestRunRegistry } from './runs.ts';
import { createGroup, upsertCase } from './store.ts';

/**
 * Агент тестов — всегда Claude Code, какой бы CLI ни был выбран в панели.
 *
 * Выбора исполнителя у раздела нет: права прогона держит брокер прав Claude
 * Code, а задание и черновик написаны под его инструменты. Живьём другие CLI
 * не проверяются (владелец запретил их трогать), поэтому это обещание — из
 * справки и из подсказки у кнопок — держит тест: запуск не передаёт свою
 * команду, и CLI берётся по умолчанию, то есть `claude`.
 */
describe('project-tests/runs: исполнитель прогона', () => {
  let root = '';
  const registry = new ProjectTestRunRegistry();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-provider-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, '2026-09-26T00:00:00.000Z');
  });

  afterEach(() => {
    registry.stop(root);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each(['run', 'generate', 'automate'] as const)(
    '%s запускает CLI по умолчанию — Claude Code',
    async (mode) => {
      const start = vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);

      registry.start({ projectPath: root, mode, groupId: 'gui' }, '2026-09-26T00:00:00.000Z');
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

      const options = start.mock.calls[0]![0] as { command?: string };
      expect(options.command).toBeUndefined();
      expect(defaultCliCommand()).toMatch(/claude/i);
    },
  );
});
