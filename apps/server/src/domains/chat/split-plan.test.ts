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

  it('сокращённая разбором задача заменяется словами владельца — с починкой в ленте (F7)', () => {
    const owner =
      'Исправить расчёт скидки для корзины с промокодом и при этом ОБЯЗАТЕЛЬНО добавить тест на округление и прогнать e2e';
    const short = 'Исправить расчёт скидки для корзины с промокодом и при этом';
    const applied = applySplitPlan(
      [{ title: 'Скидка', tasks: [owner] }, GROUPS[1] as (typeof GROUPS)[number]],
      {
        groups: [
          { index: 0, tasks: [short], owns: [], after: [] },
          { index: 1, tasks: [], owns: [], after: [] },
        ],
        conflicts: [],
        order: [],
      },
    );
    expect(applied.groups[0]?.tasks).toEqual([owner]);
    expect(applied.repairs.some((line) => line.includes('сокращ'))).toBe(true);
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
    expect(notes).toContain('"Шапка" (branch feature/header)');
    expect(notes).toContain('ended with an error');
    expect(notes).toContain('branches off feature/tests');
    expect(notes).toContain("The human's answer: только Chrome");
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

    expect(notes).toContain('already touched: src/a0.ts');
    expect(notes).toContain('src/a19.ts and 5 more');
    // Обрезанного хвоста в задании быть не должно — на то и потолок.
    expect(notes).not.toContain('src/a20.ts');
    // «Ещё пишет» и «упала» — разные новости для агента.
    expect(notes).toContain('chain did NOT finish');
    expect(notes).not.toContain('ended with an error');
    expect(notes).toContain('files touched: 3');
  });

  it('разбор просит ровно один блок, ничего не правит и нумерует группы с единицы', () => {
    const prompt = triageStagePrompt({
      shared: 'Общее',
      groups: [
        { title: 'Форма входа', branch: 'feature/login', tasks: ['починить валидацию'] },
        { title: 'Шапка', branch: 'feature/header', tasks: ['выровнять'], kind: 'mechanical' },
      ],
    });

    expect(prompt).toContain('Group 1: "Форма входа"');
    expect(prompt).toContain('Group 2: "Шапка" (branch feature/header, class mechanical)');
    expect(prompt).toContain('EDIT NOTHING');
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

    expect(prompt.split('\n')[0]).toBe('Work plan for the group "Шапка" on branch feature/header.');
    expect(prompt).toContain('on the model sonnet');
    expect(prompt).toContain('edit only here): src/header.tsx');
    expect(prompt).toContain(PLAN_BLOCK_LANG);
  });

  it('план называет критерии по каждому пункту владельца и уровень проверки до первой правки (U13)', () => {
    const prompt = planStagePrompt({ title: 'Шапка', task: 'Выровнять отступ' });

    expect(prompt).toContain(
      "one for every point of the task (when it carries the owner's request",
    );
    expect(prompt).toContain('6. Verification level, named before the first edit');
    expect(prompt).toContain('what would make it go red');
  });

  it('работа после плана несёт план; без плана — сказано прямо', () => {
    const withPlan = workAfterPlanPrompt({ task: 'Задание', plan: '## Шаги\n1. Раз' });
    const without = workAfterPlanPrompt({ task: 'Задание', notes: 'api.ts не трогать' });

    expect(withPlan).toContain('follow it step by');
    expect(withPlan).toContain('## Шаги');
    expect(without).toContain('The panel did not receive');
    expect(without).toContain('api.ts не трогать');
    expect(without.startsWith('Задание')).toBe(true);
  });
});

/**
 * 8.3 + 8.4: разбор один раз находит места и общую подготовку, а план и работа
 * начинают с них, а не ищут заново. Путь — блок разбора → разобранный план →
 * заметки применённой группы → задания уровней.
 */
describe('карта мест и общая подготовка из разбора', () => {
  const scanned = scanSplitPlanBlocks(
    block(
      SPLIT_PLAN_BLOCK_LANG,
      JSON.stringify({
        groups: [
          { index: 1, notes: 'api.ts — у Шапки', map: 'src/login/form.ts:42 — валидация' },
          { index: 2, places: 'src/header.tsx:10 — отступ' },
        ],
        setup: 'pnpm dev; стенд http://localhost:8888; вход через SSO',
      }),
    ),
    TITLES,
  );

  it('карта читается из map и из places, подготовка — с верхнего уровня', () => {
    expect(scanned.plan?.groups[0]?.map).toBe('src/login/form.ts:42 — валидация');
    expect(scanned.plan?.groups[1]?.map).toBe('src/header.tsx:10 — отступ');
    expect(scanned.plan?.setup).toBe('pnpm dev; стенд http://localhost:8888; вход через SSO');
  });

  it('длинная карта и подготовка обрезаются, а не раздувают каждую группу', () => {
    const plan = parseSplitPlan(
      { groups: [{ index: 1, map: 'м'.repeat(9_000) }], setup: 'п'.repeat(9_000) },
      TITLES,
    );

    // Обрезка помечена: модель видит, что карта неполная, а не принимает хвост за конец.
    expect(plan?.groups[0]?.map).toMatch(/^м{4000}… \[cut by the panel at 4000 of 9000 chars/);
    expect(plan?.setup).toMatch(/^п{2000}… \[cut by the panel at 2000 of 9000 chars/);
  });

  it('карта уходит в заметки своей группы, подготовка — в заметки каждой, даже без записи в разборе', () => {
    const plan = scanned.plan;
    if (!plan) throw new Error('блок разбора не разобран');
    const applied = applySplitPlan(GROUPS, plan);
    const [login, header, tests] = applied.groups.map((group) => group.notes ?? '');

    expect(login).toContain('api.ts — у Шапки');
    expect(login).toContain('Map of places from the triage');
    expect(login).toContain('src/login/form.ts:42');
    expect(login).not.toContain('src/header.tsx:10');
    expect(header).toContain('src/header.tsx:10');
    for (const notes of [login, header, tests]) {
      expect(notes).toContain('Shared setup, found once by the triage');
      expect(notes).toContain('вход через SSO');
    }
    expect(tests).not.toContain('Map of places');
  });

  it('без карты и подготовки заметки прежние — ни пустых заголовков, ни пустых заметок', () => {
    const applied = applySplitPlan(GROUPS, {
      groups: [{ index: 0, owns: [], tasks: [], after: [], notes: 'только заметка' }],
      conflicts: [],
      order: [],
    });

    expect(applied.groups[0]?.notes).toBe('только заметка');
    expect(applied.groups[1]?.notes).toBeUndefined();
  });

  it('заметки с картой доходят до плана и до работы', () => {
    const notes = composeGroupNotes({ notes: 'Map of places from the triage — x:\nsrc/a.ts:1' });
    const plan = planStagePrompt({ title: 'Шапка', task: 'Выровнять', notes });
    const work = workAfterPlanPrompt({ task: 'Задание', plan: '## Шаги\n1. Раз', notes });

    expect(plan).toContain('src/a.ts:1');
    expect(plan).toContain('start from it: check its places and add what it missed');
    expect(plan).toContain('the files and lines it touches');
    expect(work).toContain('src/a.ts:1');
    expect(work).toContain('Open the places the plan and the map name directly');
  });

  it('разбор просит карту и подготовку, но никогда не секрет', () => {
    const prompt = triageStagePrompt({
      shared: 'Общее',
      groups: [{ title: 'Форма входа', branch: 'feature/login', tasks: ['починить'] }],
    });

    expect(prompt).toContain('"map":');
    expect(prompt).toContain('"setup":');
    expect(prompt).toMatch(/never the (password|secret)/i);
  });
});
