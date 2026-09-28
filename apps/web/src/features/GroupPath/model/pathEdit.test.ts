import { describe, expect, it } from 'vitest';
import type { PathEntry, PathStep } from '@agentdeck/contracts';
import {
  anchorAfter,
  canMoveInPath,
  customSteps,
  insertAfter,
  moveInPath,
  moveToSlot,
  removeStep,
  renumber,
  replaceStep,
} from './pathEdit';
import { isBilingual, stepFromProposal } from './stepDraft';

function step(id: string, anchor: PathStep['anchor'], order: number): PathStep {
  return {
    id,
    anchor,
    order,
    kind: 'prompt',
    title: { ru: id, en: id },
    prompt: { ru: id, en: id },
    source: 'ru',
    createdAt: '2026-09-26T00:00:00.000Z',
  };
}

const plan1 = step('plan-1', 'plan', 0);
const work1 = step('work-1', 'work', 0);
const work2 = step('work-2', 'work', 1);

/** Путь так, как его собирает сервер: стадия, за ней её свои шаги. */
const ENTRIES: PathEntry[] = [
  { kind: 'builtin', stage: 'triage' },
  { kind: 'builtin', stage: 'plan' },
  { kind: 'custom', step: plan1 },
  { kind: 'builtin', stage: 'work' },
  { kind: 'skill-step', skillId: 'ticket-delivery', index: 1, title: 'Взять тикет' },
  { kind: 'custom', step: work1 },
  { kind: 'custom', step: work2 },
  { kind: 'builtin', stage: 'review' },
  { kind: 'builtin', stage: 'fix' },
  { kind: 'builtin', stage: 'deliver' },
];

const ids = (steps: PathStep[]) => steps.map((item) => `${item.anchor}:${item.id}:${item.order}`);

describe('anchorAfter', () => {
  it('берёт ближайшую стадию выше, пропуская шаги скилла', () => {
    expect(anchorAfter(ENTRIES, 0)).toBe('triage');
    expect(anchorAfter(ENTRIES, 4)).toBe('work');
    expect(anchorAfter(ENTRIES, 2)).toBe('plan');
    expect(anchorAfter(ENTRIES, 7)).toBe('review');
  });

  it('под своим шагом берёт ЕГО стадию, а не стадию строки выше', () => {
    // Путь без строки стадии над шагом (сервер вернул её ниже или не вернул):
    // вставка под шагом должна остаться в стадии этого шага.
    const loose: PathEntry[] = [
      { kind: 'builtin', stage: 'triage' },
      { kind: 'custom', step: plan1 },
    ];
    expect(anchorAfter(loose, 1)).toBe('plan');
  });

  it('выше строки нет — первая стадия конвейера; путь без стадий — сценарий, ряд work', () => {
    expect(anchorAfter(ENTRIES, -1)).toBe('triage');
    expect(anchorAfter([], 0)).toBe('work');
  });
});

describe('insertAfter', () => {
  it('«+» сразу под стадией ставит шаг первым в ней и сдвигает остальных', () => {
    const next = insertAfter(ENTRIES, 3, step('new', 'triage', 99));
    expect(ids(next)).toEqual(['plan:plan-1:0', 'work:new:0', 'work:work-1:1', 'work:work-2:2']);
  });

  it('«+» между двумя своими шагами встаёт между ними', () => {
    const next = insertAfter(ENTRIES, 5, step('new', 'triage', 0));
    expect(ids(next)).toEqual(['plan:plan-1:0', 'work:work-1:0', 'work:new:1', 'work:work-2:2']);
  });

  it('«+» после последней стадии относит шаг к ней', () => {
    const next = insertAfter(ENTRIES, ENTRIES.length - 1, step('new', 'triage', 0));
    expect(next.at(-1)).toMatchObject({ id: 'new', anchor: 'deliver', order: 0 });
  });
});

describe('renumber / replace / remove', () => {
  it('закрывает дыры в номерах внутри каждой стадии отдельно', () => {
    expect(
      ids(renumber([step('a', 'work', 5), step('b', 'plan', 3), step('c', 'work', 9)])),
    ).toEqual(['work:a:0', 'plan:b:0', 'work:c:1']);
  });

  it('правка текста не двигает шаг', () => {
    const edited = { ...work1, anchor: 'deliver' as const, title: { ru: 'новый', en: 'new' } };
    const next = replaceStep(customSteps(ENTRIES), edited);
    expect(next[1]).toMatchObject({ id: 'work-1', anchor: 'work', title: { ru: 'новый' } });
  });

  it('удаление перенумеровывает соседей', () => {
    expect(ids(removeStep(customSteps(ENTRIES), 'work-1'))).toEqual([
      'plan:plan-1:0',
      'work:work-2:0',
    ]);
  });
});

describe('шаги внутри скилла', () => {
  /** Скилл с тремя шагами и своим шагом между первым и вторым. */
  const inner = {
    ...step('inner', 'work', 0),
    within: { skillId: 'td', index: 0, after: 'Взять' },
  };
  const SKILL: PathEntry[] = [
    { kind: 'builtin', stage: 'work' },
    { kind: 'skill-step', skillId: 'td', index: 0, title: 'Взять' },
    { kind: 'custom', step: inner },
    { kind: 'skill-step', skillId: 'td', index: 1, title: 'Сделать' },
    { kind: 'skill-step', skillId: 'td', index: 2, title: 'Сдать' },
    { kind: 'custom', step: step('after', 'work', 1) },
    { kind: 'builtin', stage: 'review' },
  ];

  it('«+» между шагами скилла ставит шаг внутрь его порядка, после этого шага', () => {
    const next = insertAfter(SKILL, 3, step('new', 'triage', 0));
    expect(next.find((item) => item.id === 'new')).toMatchObject({
      anchor: 'work',
      within: { skillId: 'td', index: 1, after: 'Сделать' },
    });
  });

  it('«+» под стадией перед первым шагом скилла — до его первого шага', () => {
    const next = insertAfter(SKILL, 0, step('new', 'triage', 0));
    expect(next.find((item) => item.id === 'new')?.within).toEqual({
      skillId: 'td',
      index: -1,
      after: '',
    });
  });

  it('«+» под своим шагом внутри скилла — в то же место, следом за ним', () => {
    const next = insertAfter(SKILL, 2, step('new', 'triage', 0));
    expect(next.map((item) => item.id)).toEqual(['inner', 'new', 'after']);
    expect(next[1]?.within).toEqual(inner.within);
  });

  it('«+» после последнего шага блока — обычный шаг стадии, без within', () => {
    const next = insertAfter(SKILL, 4, step('new', 'triage', 0));
    const added = next.find((item) => item.id === 'new');
    expect(added).toMatchObject({ anchor: 'work' });
    expect(added).not.toHaveProperty('within');
  });

  it('перенос вниз через шаг скилла меняет место внутри скилла', () => {
    const next = moveInPath(SKILL, 'inner', 1);
    expect(next.find((item) => item.id === 'inner')?.within).toEqual({
      skillId: 'td',
      index: 1,
      after: 'Сделать',
    });
  });

  it('перенос шага стадии вверх заводит его внутрь скилла, вон из блока — снимает within', () => {
    const up = moveInPath(SKILL, 'after', -1);
    expect(up.find((item) => item.id === 'after')?.within).toMatchObject({ index: 1 });
    const out = moveToSlot(SKILL, 'inner', 4);
    expect(out.find((item) => item.id === 'inner')).not.toHaveProperty('within');
  });

  it('перетаскивание на своё же место ничего не меняет', () => {
    expect(moveToSlot(SKILL, 'inner', 1)).toEqual(customSteps(SKILL));
    expect(moveToSlot(SKILL, 'inner', 2)).toEqual(customSteps(SKILL));
  });

  it('правка текста шага внутри скилла не снимает его место', () => {
    const next = replaceStep(customSteps(SKILL), { ...step('inner', 'deliver', 0) });
    expect(next[0]?.within).toEqual(inner.within);
  });
});

describe('moveInPath', () => {
  it('внутри стадии меняется местами с соседом', () => {
    expect(ids(moveInPath(ENTRIES, 'work-2', -1))).toEqual([
      'plan:plan-1:0',
      'work:work-2:0',
      'work:work-1:1',
    ]);
  });

  it('через строку стадии уходит последним в предыдущую', () => {
    // work-1 стоит под шагом скилла: первый шаг вверх — внутрь скилла, второй —
    // над скиллом, третий — через строку «Работа» в план.
    let entries = ENTRIES;
    const rebuild = (steps: PathStep[]): PathEntry[] => [
      { kind: 'builtin', stage: 'triage' },
      { kind: 'builtin', stage: 'plan' },
      ...steps
        .filter((item) => item.anchor === 'plan')
        .map((item) => ({ kind: 'custom' as const, step: item })),
      { kind: 'builtin', stage: 'work' },
      ...steps
        .filter((item) => item.anchor === 'work' && item.within?.index === -1)
        .map((item) => ({ kind: 'custom' as const, step: item })),
      { kind: 'skill-step', skillId: 'ticket-delivery', index: 1, title: 'Взять тикет' },
      ...steps
        .filter((item) => item.anchor === 'work' && item.within?.index !== -1)
        .map((item) => ({ kind: 'custom' as const, step: item })),
      { kind: 'builtin', stage: 'review' },
      { kind: 'builtin', stage: 'fix' },
      { kind: 'builtin', stage: 'deliver' },
    ];
    entries = rebuild(moveInPath(entries, 'work-1', -1));
    expect(customSteps(entries).find((item) => item.id === 'work-1')?.within?.index).toBe(-1);
    entries = rebuild(moveInPath(entries, 'work-1', -1));
    expect(ids(customSteps(entries))).toContain('plan:work-1:1');
  });

  it('вниз через строку стадии уходит первым в следующую', () => {
    expect(ids(moveInPath(ENTRIES, 'work-2', 1))).toEqual([
      'plan:plan-1:0',
      'work:work-1:0',
      'review:work-2:0',
    ]);
  });

  it('с краёв пути двигаться некуда — стрелка гаснет', () => {
    const edge: PathEntry[] = [
      { kind: 'builtin', stage: 'triage' },
      { kind: 'custom', step: step('t', 'triage', 0) },
      { kind: 'builtin', stage: 'deliver' },
      { kind: 'custom', step: step('d', 'deliver', 0) },
    ];
    expect(canMoveInPath(edge, 't', -1)).toBe(false);
    expect(canMoveInPath(edge, 'd', 1)).toBe(false);
    expect(canMoveInPath(ENTRIES, 'work-1', -1)).toBe(true);
    expect(canMoveInPath(ENTRIES, 'нет', 1)).toBe(false);
  });
});

describe('stepFromProposal', () => {
  const proposal = {
    similar: [],
    questions: [],
    title: { ru: 'Прогнать линт', en: 'Run lint' },
    prompt: { ru: 'Запусти линт', en: 'Run the linter' },
  };

  it('новый шаг получает место вставки, id и сторону, которую писал человек', () => {
    const made = stepFromProposal(proposal, {
      anchor: 'review',
      lang: 'en',
      makeId: () => 'fresh',
      now: 'now',
    });
    expect(made).toMatchObject({ id: 'fresh', anchor: 'review', kind: 'prompt', source: 'en' });
    expect(made.gate).toBeUndefined();
  });

  it('правка сохраняет id, стадию и дату; найденный ресурс делает шаг ссылкой', () => {
    const made = stepFromProposal(
      { ...proposal, match: { type: 'skill', id: 'lint', why: 'то же самое' } },
      { anchor: 'deliver', lang: 'ru', existing: work1, makeId: () => 'x', now: 'later' },
    );
    expect(made).toMatchObject({
      id: 'work-1',
      anchor: 'work',
      kind: 'resource',
      resource: { type: 'skill', id: 'lint' },
      createdAt: work1.createdAt,
    });
  });

  it('шаг без одной из сторон не считается двуязычным', () => {
    expect(isBilingual({ prompt: { ru: 'текст', en: ' ' } })).toBe(false);
    expect(isBilingual({ prompt: { ru: 'текст', en: 'text' } })).toBe(true);
  });
});

describe('сценарий: шаги без стадий', () => {
  const a = step('a', 'work', 0);
  const b = step('b', 'work', 1);
  const c = step('c', 'work', 2);
  const FLAT: PathEntry[] = [a, b, c].map((item) => ({ kind: 'custom', step: item }));

  it('второй шаг поднимается на первое место — у сценария выше стадии нет', () => {
    expect(canMoveInPath(FLAT, 'b', -1)).toBe(true);
    const next = moveInPath(FLAT, 'b', -1);
    // Встал в самое начало одного-единственного ряда: место — номер, не стадия.
    expect(ids(next)).toEqual(['work:b:0', 'work:a:1', 'work:c:2']);
  });

  it('перетаскивание в самое начало (-1) у сценария работает, у конвейера — нет', () => {
    expect(moveToSlot(FLAT, 'c', -1)[0]).toMatchObject({ id: 'c', anchor: 'work', order: 0 });
    expect(moveToSlot(ENTRIES, 'plan-1', -1)).toEqual(customSteps(ENTRIES));
    expect(canMoveInPath(FLAT, 'a', -1)).toBe(false);
  });

  // F-126: у сценария один ряд — `work`, как пишет его агент панели
  // (actions-groups `placed`). Вставка наверх под `triage` давала сценарию две
  // стадии, и номер «встать N-м», посчитанный по ряду `work`, промахивался.
  it('«+» в самом верху сценария — тот же ряд work, первым по номеру', () => {
    expect(anchorAfter(FLAT, -1)).toBe('work');
    expect(anchorAfter([], -1)).toBe('work');
    expect(ids(insertAfter(FLAT, -1, step('x', 'triage', 0)))).toEqual([
      'work:x:0',
      'work:a:1',
      'work:b:2',
      'work:c:3',
    ]);
  });

  it('сценарий со стадиями из прежних сохранений сводится в один ряд по порядку списка', () => {
    const legacy: PathEntry[] = [step('t', 'triage', 0), a, b].map((item) => ({
      kind: 'custom',
      step: item,
    }));
    expect(ids(insertAfter(legacy, 1, step('y', 'work', 0)))).toEqual([
      'work:t:0',
      'work:a:1',
      'work:y:2',
      'work:b:3',
    ]);
  });
});
