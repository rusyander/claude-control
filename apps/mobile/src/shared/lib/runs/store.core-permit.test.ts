import { describe, expect, it } from 'vitest';
import { applyEvent, getRun, setRun } from './store';

/**
 * Карточка права в самом чате телефона (G9): ход чата идёт задачей ядра, и его вопрос права
 * приходит потоком с полями ядра. Без них карточка ушла бы маршрутом прогона и получила отказ
 * `core_permit_browser_only` — стор обязан донести их до карточки.
 */
const core = {
  taskId: 'task-1',
  askId: 'ask-1',
  point: 5,
  options: ['grant', 'refuse'],
  project: 'r1',
  globs: ['migrations/1.sql'],
};

describe('store — chat core permit card', () => {
  it('a permission event with core facts keeps them on the pending card', () => {
    setRun('m-core-1', { status: 'running' });
    applyEvent('m-core-1', {
      kind: 'permission',
      toolName: 'core-permit',
      input: { question: 'The step needs a grant to edit migrations/1.sql (Edit)' },
      toolUseId: 'ask-1',
      core,
    });
    applyEvent('m-core-1', {
      kind: 'permission',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 't2',
    });
    const [coreCard, cliCard] = getRun('m-core-1').permissions;
    expect(coreCard).toMatchObject({ toolUseId: 'ask-1', core });
    expect(cliCard).not.toHaveProperty('core');
  });
});
