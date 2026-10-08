import { describe, expect, it } from 'vitest';
import type {
  ProjectTestCase,
  ProjectTestGroup,
  ProjectTestTaxonomyPlan,
} from '@agentdeck/contracts';
import { suggestTaxonomy } from './taxonomy.ts';

/**
 * Таксономия: предложить переносы и не тронуть содержимое.
 *
 * Проверяется ровно то, из-за чего такой кнопкой перестают пользоваться:
 * «уборка», меняющая кейсы, и «уборка», которая на прибранном наборе всё равно
 * предлагает что-то перенести.
 */

function testCase(over: Partial<ProjectTestCase> = {}): ProjectTestCase {
  return {
    id: 'gui-001',
    type: 'case',
    title: 'Вход с верными данными',
    steps: [],
    status: 'unknown',
    source: 'human',
    ...over,
  };
}

function group(cases: ProjectTestCase[], id = 'gui'): ProjectTestGroup {
  return { id, title: id.toUpperCase(), file: `.agent/tests/${id}.tests.json`, cases };
}

/** Применить предложенные переносы — так их применит и массовое действие панели. */
function apply(groups: ProjectTestGroup[], plan: ProjectTestTaxonomyPlan): ProjectTestGroup[] {
  const next = structuredClone(groups);
  for (const move of plan.moves) {
    const found = next.find((item) => item.id === move.groupId);
    for (const caseId of move.caseIds) {
      const target = found?.cases.find((item) => item.id === caseId);
      if (target && move.section) target.section = move.section;
    }
  }
  return next;
}

describe('project-tests/taxonomy', () => {
  it('кейс без секции переезжает к собратьям по зоне', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Вложение', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-003', title: 'Черновик', area: 'chat' }),
      ]),
    ]);

    expect(plan.total).toBe(1);
    expect(plan.moves).toEqual([
      {
        groupId: 'gui',
        caseIds: ['gui-003'],
        section: 'Чат',
        reason: 'зона «chat»: 2 кейсов этой зоны уже в секции «Чат»',
      },
    ]);
  });

  it('признаётся общее начало названия, когда зоны у кейса нет', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({ id: 'gui-001', title: 'Чат: отправка', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Чат: вложение', section: 'Чат' }),
        testCase({ id: 'gui-003', title: 'Чат: черновик' }),
      ]),
    ]);

    expect(plan.moves[0]?.section).toBe('Чат');
    expect(plan.moves[0]?.reason).toContain('общее начало названия «Чат»');
  });

  it('признаётся общий код, когда нет ни зоны, ни общего начала', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({
          id: 'gui-001',
          title: 'Отправка',
          section: 'Экран чата',
          codePaths: ['src/pages/Chat/ChatPage.tsx'],
        }),
        testCase({
          id: 'gui-002',
          title: 'Вложение',
          section: 'Экран чата',
          codePaths: ['src/pages/Chat/Attach.tsx'],
        }),
        testCase({ id: 'gui-003', title: 'Черновик', codePaths: ['src/pages/Chat/Draft.tsx'] }),
      ]),
    ]);

    expect(plan.moves[0]?.section).toBe('Экран чата');
    expect(plan.moves[0]?.reason).toContain('общий код «src/pages/Chat»');
  });

  it('секция из одного кейса расформировывается к населённым собратьям', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Вложение', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-003', title: 'Черновик', area: 'chat', section: 'Черновики' }),
      ]),
    ]);

    expect(plan.total).toBe(1);
    expect(plan.moves[0]?.caseIds).toEqual(['gui-003']);
    expect(plan.moves[0]?.section).toBe('Чат');
    expect(plan.moves[0]?.reason).toContain('в секции «Черновики» остался один кейс');
  });

  it('переносы с одной причиной склеиваются в одну строку', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Вложение', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-003', title: 'Черновик', area: 'chat' }),
        testCase({ id: 'gui-004', title: 'Поиск', area: 'chat' }),
      ]),
    ]);

    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]?.caseIds).toEqual(['gui-003', 'gui-004']);
    expect(plan.total).toBe(2);
  });

  it('ничья секций — молчание вместо догадки', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Первая' }),
        testCase({ id: 'gui-002', title: 'Вложение', area: 'chat', section: 'Первая' }),
        testCase({ id: 'gui-003', title: 'Поиск', area: 'chat', section: 'Вторая' }),
        testCase({ id: 'gui-004', title: 'Копия', area: 'chat', section: 'Вторая' }),
        testCase({ id: 'gui-005', title: 'Черновик', area: 'chat' }),
      ]),
    ]);

    expect(plan).toEqual({ moves: [], total: 0 });
  });

  it('одинокого соседа мало: по одному кейсу секцию домом не считают', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Черновик', area: 'chat' }),
      ]),
    ]);

    expect(plan.total).toBe(0);
  });

  it('архивный кейс ни переезжает, ни голосует за секцию', () => {
    const plan = suggestTaxonomy([
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({
          id: 'gui-002',
          title: 'Вложение',
          area: 'chat',
          section: 'Чат',
          archived: true,
        }),
        testCase({ id: 'gui-003', title: 'Черновик', area: 'chat' }),
        testCase({ id: 'gui-004', title: 'Старьё', area: 'chat', archived: true }),
      ]),
    ]);

    expect(plan.total).toBe(0);
  });

  it('прибранный набор — ноль переносов, и повтор после применения тоже', () => {
    const messy = [
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Вложение', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-003', title: 'Черновик', area: 'chat' }),
        testCase({ id: 'gui-004', title: 'Поиск', area: 'chat', section: 'Поиск' }),
        testCase({ id: 'gui-005', title: 'Отчёт', area: 'analytics', section: 'Аналитика' }),
        testCase({ id: 'gui-006', title: 'Выгрузка', area: 'analytics', section: 'Аналитика' }),
      ]),
    ];

    const first = suggestTaxonomy(messy);
    expect(first.total).toBe(2);

    // Второй проход по уже разложенному набору не находит ни одного улучшения —
    // иначе «применить» пришлось бы жать, пока не надоест.
    expect(suggestTaxonomy(apply(messy, first))).toEqual({ moves: [], total: 0 });
  });

  it('предлагается только перенос: содержимое кейсов не меняется', () => {
    const groups = [
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Вложение', area: 'chat', section: 'Чат' }),
        testCase({
          id: 'gui-003',
          title: 'Черновик',
          area: 'chat',
          steps: [{ action: 'Открыть чат', expected: 'Список сообщений' }],
          expected: 'Черновик сохранён',
        }),
      ]),
    ];
    const before = structuredClone(groups);
    const plan = suggestTaxonomy(groups);

    // Сами группы правило не трогает: оно только описывает, что сделать.
    expect(groups).toEqual(before);
    // И в предложении нет ни одного поля, кроме адреса переноса и причины.
    for (const move of plan.moves) {
      expect(Object.keys(move).sort()).toEqual(['caseIds', 'groupId', 'reason', 'section']);
    }
  });

  it('сломанная группа пропускается, а не роняет разбор', () => {
    const plan = suggestTaxonomy([
      {
        id: 'broken',
        title: 'BROKEN',
        file: '.agent/tests/broken.tests.json',
        cases: [],
        error: 'плохой JSON',
      },
      group([
        testCase({ id: 'gui-001', title: 'Отправка', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-002', title: 'Вложение', area: 'chat', section: 'Чат' }),
        testCase({ id: 'gui-003', title: 'Черновик', area: 'chat' }),
      ]),
    ]);

    expect(plan.total).toBe(1);
  });
});
