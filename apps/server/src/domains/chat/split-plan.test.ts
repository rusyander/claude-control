import { describe, it, expect } from 'vitest';
import {
  applySplitPlan,
  composeGroupNotes,
  parseSplitPlan,
  planStagePrompt,
  scanPlanBlocks,
  scanSplitPlanBlocks,
  triageStagePrompt,
  workAfterPlanPrompt,
  PLAN_BLOCK_LANG,
  SPLIT_PLAN_BLOCK_LANG,
} from '@agentdeck/contracts/split-plan';

/**
 * Уровни разделения (Т1): блок разбора и блок плана. Проверяется то, из-за
 * чего уровни могут навредить: потерянная задача, ожидание по кругу, план,
 * обрезанный на первом же вложенном блоке кода.
 */

const TITLES = ['Форма входа', 'Шапка', 'Тесты'];

const GROUPS = [
  { title: 'Форма входа', tasks: ['починить валидацию', 'убрать дубль запроса'] },
  { title: 'Шапка', tasks: ['выровнять отступ'] },
  { title: 'Тесты', tasks: ['добавить тест на форму'] },
];

function block(lang: string, body: string): string {
  return ['```' + lang, body, '```'].join('\n');
}

describe('parseSplitPlan: терпимость к форме', () => {
  it('группы по номеру с единицы и по названию; hold строкой и объектом', () => {
    const plan = parseSplitPlan(
      {
        groups: [
          { index: 1, owns: ['src/login'], after: ['Шапка'], hold: 'какой валидатор?' },
          { title: 'Шапка', files: 'src/header.tsx', hold: { question: 'цвет?' } },
          { group: '#3', dependsOn: [1, 2] },
        ],
        conflicts: [{ paths: ['src/api.ts'], resolvedBy: 'Форма входа', why: 'она зовёт' }],
        order: [2, 1, 3],
      },
      TITLES,
    );

    expect(plan?.groups.map((group) => group.index)).toEqual([0, 1, 2]);
    expect(plan?.groups[0]).toMatchObject({ after: [1], hold: 'какой валидатор?' });
    expect(plan?.groups[1]).toMatchObject({ owns: ['src/header.tsx'], hold: 'цвет?' });
    expect(plan?.groups[2]?.after).toEqual([0, 1]);
    expect(plan?.conflicts[0]).toMatchObject({ resolvedBy: 0, why: 'она зовёт' });
    expect(plan?.order).toEqual([1, 0, 2]);
  });

  it('ссылка на себя и на неизвестную группу отбрасывается, а не угадывается', () => {
    const plan = parseSplitPlan({ groups: [{ index: 1, after: [1, 9, 'Нет такой'] }] }, TITLES);

    expect(plan?.groups[0]?.after).toEqual([]);
  });

  it('без единой узнаваемой группы блок не разобран', () => {
    expect(parseSplitPlan({ groups: [{ index: 42 }] }, TITLES)).toBeUndefined();
    expect(parseSplitPlan('не json', TITLES)).toBeUndefined();
  });
});

describe('scanSplitPlanBlocks', () => {
  it('разобранный блок уходит из показа, текст перед ним остаётся', () => {
    const scan = scanSplitPlanBlocks(
      `Пересекались в api.ts.\n\n${block(SPLIT_PLAN_BLOCK_LANG, JSON.stringify({ groups: [{ index: 1 }] }))}`,
      TITLES,
    );

    expect(scan.text).toBe('Пересекались в api.ts.');
    expect(scan.plan?.groups).toHaveLength(1);
    expect(scan.rejected).toBe(0);
  });

  it('непонятый блок остаётся в тексте и считается', () => {
    const scan = scanSplitPlanBlocks(block(SPLIT_PLAN_BLOCK_LANG, '{ не json }'), TITLES);

    expect(scan.plan).toBeUndefined();
    expect(scan.rejected).toBe(1);
    expect(scan.text).toContain('не json');
  });
});

describe('scanPlanBlocks: план с вложенными блоками кода', () => {
  it('закрывающей считается ПОСЛЕДНЯЯ кавычка: вложенный блок команд план не обрывает', () => {
    const plan = [
      '## Шаги',
      '1. Запустить проверку:',
      '```',
      'pnpm test',
      '```',
      '2. Поправить импорт.',
    ].join('\n');
    const scan = scanPlanBlocks(`Готово.\n\n${block(PLAN_BLOCK_LANG, plan)}`);

    expect(scan.plan).toContain('pnpm test');
    expect(scan.plan).toContain('Поправить импорт');
    expect(scan.text).toBe('Готово.');
  });

  it('недописанный блок прячется до конца, плана нет', () => {
    const scan = scanPlanBlocks('Вот план.\n\n```' + PLAN_BLOCK_LANG + '\n## Шаги\n1. ...');

    expect(scan.plan).toBeUndefined();
    expect(scan.text).toBe('Вот план.');
  });
});

describe('applySplitPlan: панель не доверяет разбору', () => {
  it('переносит задачи, отдаёт границы и заметки, строит порядок по after', () => {
    const applied = applySplitPlan(GROUPS, {
      groups: [
        {
          index: 0,
          owns: ['src/login'],
          tasks: ['починить валидацию'],
          after: [],
          notes: 'api.ts — у Шапки',
        },
        {
          index: 1,
          owns: ['src/header.tsx', 'src/api.ts'],
          tasks: ['выровнять отступ', 'убрать дубль запроса'],
          after: [],
        },
        {
          index: 2,
          owns: [],
          tasks: ['добавить тест на форму'],
          after: [0, 1],
          hold: 'какие браузеры?',
        },
      ],
      conflicts: [{ paths: ['src/api.ts'], resolvedBy: 1, why: 'её задача' }],
      order: [1],
    });

    expect(applied.groups[0]?.tasks).toEqual(['починить валидацию']);
    expect(applied.groups[1]?.tasks).toEqual(['выровнять отступ', 'убрать дубль запроса']);
    expect(applied.groups[0]?.notes).toBe('api.ts — у Шапки');
    expect(applied.groups[2]).toMatchObject({ after: [0, 1], hold: 'какие браузеры?' });
    // Заявленный порядок дополняется топологией: 2 ждёт 0 и 1.
    expect(applied.order).toEqual([1, 0, 2]);
    expect(applied.repairs).toEqual([]);
  });

  it('потерянная задача возвращается домой, повтор остаётся в первой группе', () => {
    const applied = applySplitPlan(GROUPS, {
      groups: [
        { index: 0, owns: [], tasks: ['починить валидацию'], after: [] },
        { index: 1, owns: [], tasks: ['выровнять отступ', 'починить валидацию'], after: [] },
      ],
      conflicts: [],
      order: [],
    });

    expect(applied.groups[0]?.tasks).toEqual(['починить валидацию', 'убрать дубль запроса']);
    expect(applied.groups[1]?.tasks).toEqual(['выровнять отступ']);
    expect(applied.groups[2]?.tasks).toEqual(['добавить тест на форму']);
    expect(applied.repairs.join('\n')).toContain('повторялась');
    expect(applied.repairs.join('\n')).toContain('пропала из разбора');
  });

  /**
   * Итоговая проверка 25.09 (D3): строка, стоявшая в КАЖДОЙ группе уже в
   * предложении («Проверить исправление: node test.mjs»), не повтор разбора —
   * раньше она оставалась только у первой группы.
   */
  it('общая строка предложения остаётся у всех групп, повтором не считается', () => {
    const shared = 'Проверить исправление: node test.mjs';
    const withShared = GROUPS.map((group) => ({ ...group, tasks: [...group.tasks, shared] }));
    const applied = applySplitPlan(withShared, {
      groups: withShared.map((group, index) => ({
        index,
        owns: [],
        tasks: group.tasks,
        after: [],
      })),
      conflicts: [],
      order: [],
    });

    for (const group of applied.groups) expect(group.tasks).toContain(shared);
    expect(applied.repairs).toEqual([]);
  });

  it('ожидание по кругу снимается — стоять вечно нельзя', () => {
    const applied = applySplitPlan(GROUPS, {
      groups: [
        { index: 0, owns: [], tasks: [], after: [1] },
        { index: 1, owns: [], tasks: [], after: [0] },
      ],
      conflicts: [],
      order: [],
    });

    // Ребро, замыкающее круг, снимается у первой группы по порядку; вторая ждёт как просила.
    expect(applied.groups[0]?.after).toEqual([]);
    expect(applied.groups[1]?.after).toEqual([0]);
    expect(applied.repairs.join('\n')).toContain('ждали друг друга');
    expect(applied.order).toEqual([0, 1, 2]);
  });
});

describe('заметки и задания уровней', () => {
  it('composeGroupNotes собирает разбор, предшественников, базу и ответ человека', () => {
    const notes = composeGroupNotes({
      notes: 'api.ts не трогать',
      predecessors: [
        { title: 'Шапка', branch: 'feature/header' },
        { title: 'Тесты', branch: 'feature/tests', failed: true },
      ],
      base: 'feature/tests',
      holdAnswer: { question: 'какие браузеры?', answer: 'только Chrome' },
    });

    expect(notes).toContain('api.ts не трогать');
    expect(notes).toContain('«Шапка» (ветка feature/header)');
    expect(notes).toContain('завершилась ошибкой');
    expect(notes).toContain('отведена от ветки feature/tests');
    expect(notes).toContain('Ответ человека: только Chrome');
    expect(composeGroupNotes({})).toBeUndefined();
  });

  it('заметка называет задетые файлы с потолком и незаконченную цепочку отдельно от упавшей', () => {
    const many = Array.from({ length: 25 }, (_, index) => `src/a${index}.ts`);
    const notes = composeGroupNotes({
      predecessors: [
        { title: 'Шапка', branch: 'feature/header', files: many.slice(0, 20), filesTotal: 25 },
        { title: 'Тесты', branch: 'feature/tests', unfinished: true, filesTotal: 3 },
      ],
    });

    expect(notes).toContain('уже задеты: src/a0.ts');
    expect(notes).toContain('src/a19.ts и ещё 5');
    // Обрезанного хвоста в задании быть не должно — на то и потолок.
    expect(notes).not.toContain('src/a20.ts');
    // «Ещё пишет» и «упала» — разные новости для агента.
    expect(notes).toContain('цепочка НЕ кончилась');
    expect(notes).not.toContain('завершилась ошибкой');
    expect(notes).toContain('задето файлов: 3');
  });

  it('разбор просит ровно один блок, ничего не правит и нумерует группы с единицы', () => {
    const prompt = triageStagePrompt({
      shared: 'Общее',
      groups: [
        { title: 'Форма входа', branch: 'feature/login', tasks: ['починить валидацию'] },
        { title: 'Шапка', branch: 'feature/header', tasks: ['выровнять'], kind: 'mechanical' },
      ],
    });

    expect(prompt).toContain('Группа 1: «Форма входа»');
    expect(prompt).toContain('Группа 2: «Шапка» (ветка feature/header, класс mechanical)');
    expect(prompt).toContain('НИЧЕГО НЕ ПРАВЬ');
    expect(prompt).toContain(SPLIT_PLAN_BLOCK_LANG);
  });

  it('план начинается названием группы — это заголовок чата — и просит блок плана', () => {
    const prompt = planStagePrompt({
      title: 'Шапка',
      branch: 'feature/header',
      task: 'Выровнять отступ',
      owns: ['src/header.tsx'],
      workModel: 'sonnet',
    });

    expect(prompt.split('\n')[0]).toBe('План работы для группы «Шапка» в ветке feature/header.');
    expect(prompt).toContain('на модели sonnet');
    expect(prompt).toContain('правь только здесь): src/header.tsx');
    expect(prompt).toContain(PLAN_BLOCK_LANG);
  });

  it('работа после плана несёт план; без плана — сказано прямо', () => {
    const withPlan = workAfterPlanPrompt({ task: 'Задание', plan: '## Шаги\n1. Раз' });
    const without = workAfterPlanPrompt({ task: 'Задание', notes: 'api.ts не трогать' });

    expect(withPlan).toContain('следуй ему по шагам');
    expect(withPlan).toContain('## Шаги');
    expect(without).toContain('панель не получила');
    expect(without).toContain('api.ts не трогать');
    expect(without.startsWith('Задание')).toBe(true);
  });
});
