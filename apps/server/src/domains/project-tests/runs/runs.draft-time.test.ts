import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun, type ChatEvent } from '../../chat/ChatRunner/ChatRunner.ts';
import { draftFile, readDrafts } from '../drafts/drafts.ts';
import { ProjectTestRunRegistry } from './runs.ts';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Время черновика ставит панель, а не агент.
 *
 * Живой прогон 26.09: генерация написала `"createdAt": "2026-09-26T12:00:00.000Z"`
 * — полдень завтрашнего дня, выдуманный вместо текущего времени. Черновики
 * сортируются по этому полю «от новых к старым», и такой черновик стоял бы
 * первым, заслоняя в плашке «ждут решения» всё, что генерация принесёт потом.
 * Тот же класс, что местное время с буквой Z у `lastRunAt`.
 */
describe('project-tests/runs: время черновика', () => {
  let root = '';
  const registry = new ProjectTestRunRegistry();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-draft-time-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, '2026-09-25T20:00:00.000Z');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('выдуманное агентом время заменяется временем конца генерации', async () => {
    let runId = '';
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (_options, onEvent) => {
      const file = join(root, draftFile(runId));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          runId,
          source: 'code',
          createdAt: '2099-01-01T12:00:00.000Z',
          items: [
            {
              op: 'add',
              groupId: 'gui',
              caseId: 'gui-002',
              testCase: { id: 'gui-002', title: 'B', steps: ['y'] },
              reason: 'нет проверки',
            },
          ],
        }),
      );
      (onEvent as (event: ChatEvent) => void)({ kind: 'done', sessionId: 's1' } as ChatEvent);
    });

    const view = registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui' },
      '2026-09-25T21:00:00.000Z',
    );
    runId = view.id;
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'));

    const finishedAt = registry.get(root)?.finishedAt;
    const [draft] = readDrafts(root);
    expect(draft?.runId).toBe(runId);
    expect(draft?.createdAt).toBe(finishedAt);
  });

  it('отброшенная правка агента видна после конца прогона: в черновике и в логе (X-1)', async () => {
    let runId = '';
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (_options, onEvent) => {
      const file = join(root, draftFile(runId));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          runId,
          createdAt: '2099-01-01T12:00:00.000Z',
          items: [
            { op: 'delete', groupId: 'gui', caseId: 'gui-001', testCase: { title: 'A' } },
            {
              op: 'add',
              groupId: 'gui',
              caseId: 'gui-002',
              testCase: { id: 'gui-002', title: 'B', steps: ['y'] },
            },
          ],
        }),
      );
      (onEvent as (event: ChatEvent) => void)({ kind: 'done', sessionId: 's1' } as ChatEvent);
    });

    runId = registry.start(
      { projectPath: root, mode: 'generate', groupId: 'gui' },
      '2026-09-25T21:00:00.000Z',
    ).id;
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'));

    const [draft] = readDrafts(root);
    expect(draft?.warnings?.join(' ')).toContain('«delete»');
    expect(registry.get(root)?.log).toContain('«delete»');
  });
});
