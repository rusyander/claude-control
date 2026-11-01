import { describe, expect, it } from 'vitest';
import {
  CREATED,
  FIRST_ROUND,
  openFresh,
  SOLO_UNIT,
} from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { sourceRepoOf } from './source-repo.ts';

/**
 * Исходный репозиторий шага для доверия CLI (F-86): путь из `task.created.repos[]`, у задачи
 * нескольких репозиториев — тот, чей ключ у единицы шага. Не нашёлся — нет (копия недоверенная).
 */

const REPOS = [
  { repoKey: 'front', path: '/src/front', baseRef: 'main' },
  { repoKey: 'back', path: '/src/back', baseRef: 'main' },
];

function step(task: LiveTask, repoKey: string): string {
  const unitId = newId();
  const stepId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey,
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: 'work', budgetMs: 60_000, ...FIRST_ROUND },
  });
  return stepId;
}

describe('source repo of a step (F-86 trust)', () => {
  it('one repo → its path; several → the repo of the step’s unit; unknown key or step → none', async () => {
    const one = (await openFresh()).task;
    one.append({ kind: 'task.created', actor: 'core', data: CREATED });
    expect(sourceRepoOf(one, step(one, 'r1'))).toBe(CREATED.repos[0]!.path);

    const many = (await openFresh()).task;
    many.append({ kind: 'task.created', actor: 'core', data: { ...CREATED, repos: REPOS } });
    expect(sourceRepoOf(many, step(many, 'back'))).toBe('/src/back');
    expect(sourceRepoOf(many, step(many, 'front'))).toBe('/src/front');
    expect(sourceRepoOf(many, step(many, 'gone'))).toBeUndefined();
    expect(sourceRepoOf(many, newId())).toBeUndefined();

    const none = (await openFresh()).task;
    none.append({ kind: 'task.created', actor: 'core', data: { ...CREATED, repos: [] } });
    expect(sourceRepoOf(none, step(none, 'r1'))).toBeUndefined();
  });
});
