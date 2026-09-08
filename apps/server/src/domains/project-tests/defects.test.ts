import type { ProjectTestCase } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { buildDraft } from './defects.ts';

/**
 * Черновик дефекта.
 *
 * Собирается ВСЕГДА, даже когда трекера рядом нет: шаги, ожидание и то, что
 * увидели на самом деле, — половина работы тестировщика, и она не должна
 * зависеть от того, стоит ли в системе `gh` или `glab`.
 */
describe('project-tests/defects', () => {
  const testCase: ProjectTestCase = {
    id: 'gui-001',
    type: 'case',
    title: 'Сообщение не отправляется',
    area: 'chat',
    precondition: 'открыт чат проекта',
    steps: [
      { action: 'ввести текст', data: 'привет' },
      { action: 'нажать «Отправить»', expected: 'сообщение в ленте' },
    ],
    expected: 'сообщение появляется в ленте',
    status: 'failed',
    note: 'кнопка неактивна',
    source: 'agent',
  };

  it('в черновик попадают шаги нумерованным списком, ожидание и факт', () => {
    const draft = buildDraft(testCase, { groupId: 'gui', branch: 'main', commit: 'abc1234' });

    expect(draft.title).toContain('Сообщение не отправляется');
    expect(draft.body).toContain('1. ввести текст');
    expect(draft.body).toContain('2. нажать «Отправить»');
    expect(draft.body).toContain('сообщение появляется в ленте');
    expect(draft.body).toContain('кнопка неактивна');
    expect(draft.body).toContain('main');
    expect(draft.body).toContain('abc1234');
  });

  it('результат прохода важнее записи в кейсе — он свежее', () => {
    const draft = buildDraft(testCase, {
      groupId: 'gui',
      environmentTitle: 'Chrome',
      result: {
        pointId: 'gui:gui-001',
        groupId: 'gui',
        caseId: 'gui-001',
        status: 'failed',
        note: 'сервер отвечает 500',
        attachments: ['.agent/tests/attachments/gui-001/shot.png'],
      },
    });

    expect(draft.body).toContain('сервер отвечает 500');
    expect(draft.body).not.toContain('кнопка неактивна');
    expect(draft.body).toContain('shot.png');
    expect(draft.body).toContain('Chrome');
  });

  /**
   * Разбор провала — то, ради чего дефект вообще заводят из панели: номер шага,
   * ожидание именно на нём и то, что вышло. Пересказывать это руками означало бы
   * делать работу, которую прогон уже сделал.
   */
  it('черновик берёт номер шага, ожидание шага и факт из разбора провала', () => {
    const draft = buildDraft(testCase, {
      groupId: 'gui',
      result: {
        pointId: 'gui:gui-001',
        groupId: 'gui',
        caseId: 'gui-001',
        status: 'failed',
        note: 'кнопка неактивна',
        failure: {
          step: 2,
          expected: 'сообщение в ленте',
          actual: 'лента пустая, в консоли 500',
          retry: 'confirmed',
        },
      },
    });

    expect(draft.body).toContain('Провалился шаг 2');
    // Провалившийся шаг помечен в самом списке: тот, кто чинит, ищет глазами
    // место, а не сверяет номер из соседнего абзаца.
    expect(draft.body).toMatch(/2\. нажать «Отправить».* ← провал/);
    expect(draft.body).not.toMatch(/1\. ввести текст.* ← провал/);
    expect(draft.body).toContain('лента пустая, в консоли 500');
    expect(draft.body).toContain('провал подтверждён');
  });

  it('разошедшаяся вторая попытка названа отдельно: чинить надо сначала тест', () => {
    const draft = buildDraft(
      {
        ...testCase,
        failure: { step: 1, retry: 'flaky', retryNote: 'со второго раза отправилось' },
      },
      { groupId: 'gui' },
    );

    expect(draft.body).toContain('Вторая попытка разошлась');
    expect(draft.body).toContain('со второго раза отправилось');
  });

  it('кейс без описанных шагов не даёт пустого раздела', () => {
    const draft = buildDraft(
      { ...testCase, steps: [], expected: undefined, note: undefined },
      {
        groupId: 'gui',
      },
    );

    expect(draft.body).toContain('не описаны');
    expect(draft.body).toContain('не описано');
  });
});
