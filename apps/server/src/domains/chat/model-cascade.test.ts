import { describe, it, expect } from 'vitest';
import {
  ASSIGNABLE_EFFORTS,
  ASSIGNABLE_MODELS,
  assignableEffortsUpTo,
  assignableModelsUpTo,
  ceilingModelRank,
  clampAssignment,
  fixStagePrompt,
  loweredWorkPrompt,
  manualAssignment,
  modelAlias,
  parseAssignments,
  parseReviewFindings,
  plannedRunCount,
  reviewStagePrompt,
  scanReviewBlocks,
  REVIEW_BLOCK_LANG,
  EFFORT_RANK,
  KIND_PLAN,
  MODEL_RANK,
  planAssignment,
  TASK_KINDS,
} from '@agentdeck/contracts/model-cascade';

/**
 * Контракт каскада лежит в `packages/contracts`, а тесты — здесь: пакет
 * контрактов своего прогона не имеет, и его логику проверяет тот, кто ей
 * пользуется (так же устроены `task-split` и `permission-rules`).
 */

/** Потолки, которые встречаются живьём: алиас, конкретное имя, пусто, чужое. */
const CEILINGS = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5', 'claude-opus-5[1m]', ''];
const EFFORT_CEILINGS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
/** Всё, что модель может написать в поле: своё, чужое, запрещённое, мусор. */
const WANTED = [
  ...ASSIGNABLE_MODELS,
  'gpt-5',
  'claude-3-opus-20240229',
  'MAX',
  'опус',
  '',
  undefined,
];
const WANTED_EFFORTS = [...ASSIGNABLE_EFFORTS, 'max', 'ultra', 'HIGH', '', undefined];

describe('clampAssignment', () => {
  /**
   * Главный инвариант партии, и проверяется он перебором, а не примерами:
   * назначение никогда не поднимает ребёнка выше потолка и никогда не выдаёт
   * `max` — даже когда `max` выбран потолком.
   */
  it('перебором: не выше потолка и никогда max', () => {
    for (const model of CEILINGS) {
      for (const effort of EFFORT_CEILINGS) {
        const ceilingRank = ceilingModelRank(model);
        for (const wantedModel of WANTED) {
          for (const wantedEffort of WANTED_EFFORTS) {
            const choice = clampAssignment(
              { model: wantedModel, effort: wantedEffort },
              { model, effort },
            );

            expect(choice.effort).not.toBe('max');

            const chosenEffort = EFFORT_RANK[choice.effort as keyof typeof EFFORT_RANK];
            if (chosenEffort !== undefined) {
              const cap =
                effort === '' || effort === 'max'
                  ? EFFORT_RANK.xhigh
                  : EFFORT_RANK[effort as keyof typeof EFFORT_RANK];
              expect(chosenEffort).toBeLessThanOrEqual(cap);
            }

            // Ранг ниже потолка означает алиас: конкретное имя ребёнку не
            // назначается вовсе, поэтому сравнивать есть с чем всегда.
            const chosenModel = MODEL_RANK[choice.model as keyof typeof MODEL_RANK];
            if (chosenModel !== undefined && ceilingRank !== undefined) {
              expect(chosenModel).toBeLessThanOrEqual(ceilingRank);
            }
          }
        }
      }
    }
  });

  it('модель ниже потолка уходит алиасом, равная и выше — самим потолком', () => {
    const ceiling = { model: 'claude-opus-5', effort: 'high' };
    expect(clampAssignment({ model: 'sonnet' }, ceiling).model).toBe('sonnet');
    expect(clampAssignment({ model: 'haiku' }, ceiling).model).toBe('haiku');
    // Равная потолку — это и есть потолок: подменять выбранное человеком имя
    // алиасом семейства незачем.
    expect(clampAssignment({ model: 'opus' }, ceiling).model).toBe('claude-opus-5');
    expect(clampAssignment({ model: 'fable' }, ceiling).model).toBe('claude-opus-5');
  });

  it('чужое, неизвестное и незаполненное — на потолок, группа не теряется', () => {
    const ceiling = { model: 'opus', effort: 'xhigh' };
    expect(clampAssignment({ model: 'gpt-5' }, ceiling)).toEqual({
      model: 'opus',
      effort: 'xhigh',
    });
    expect(clampAssignment({ model: 'claude-3-opus-20240229' }, ceiling).model).toBe('opus');
    expect(clampAssignment({}, ceiling)).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(clampAssignment(undefined, ceiling)).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  it('нераспознанный потолок выключает каскад по модели, глубина работает', () => {
    expect(
      clampAssignment({ model: 'sonnet', effort: 'medium' }, { model: '', effort: '' }),
    ).toEqual({ model: '', effort: 'medium' });
    expect(clampAssignment({ model: 'haiku' }, { model: 'gpt-5-codex', effort: '' }).model).toBe(
      'gpt-5-codex',
    );
  });

  it('глубина: потолок max срезается до xhigh, пустой потолок ничего не запрещает', () => {
    expect(clampAssignment({ effort: 'xhigh' }, { model: 'opus', effort: 'max' }).effort).toBe(
      'xhigh',
    );
    expect(clampAssignment({}, { model: 'opus', effort: 'max' }).effort).toBe('xhigh');
    expect(clampAssignment({ effort: 'xhigh' }, { model: 'opus', effort: '' }).effort).toBe(
      'xhigh',
    );
    expect(clampAssignment({ effort: 'xhigh' }, { model: 'opus', effort: 'medium' }).effort).toBe(
      'medium',
    );
    expect(clampAssignment({ effort: 'low' }, { model: 'opus', effort: 'medium' }).effort).toBe(
      'low',
    );
  });

  it('регистр и пробелы не мешают: модель пишет как придётся', () => {
    const ceiling = { model: 'opus', effort: 'high' };
    expect(clampAssignment({ model: ' Sonnet ', effort: ' MEDIUM ' }, ceiling)).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
  });
});

describe('planAssignment — подбор под класс задачи', () => {
  const ceiling = { model: 'claude-opus-5', effort: 'high' };

  it('класс решает, чем делать; удешевлять нельзя — значит потолок', () => {
    expect(planAssignment({ kind: 'mechanical' }, ceiling)).toMatchObject({
      model: 'sonnet',
      effort: 'medium',
      kind: 'mechanical',
      lowered: true,
    });
    expect(planAssignment({ kind: 'implementation' }, ceiling)).toMatchObject({
      model: 'sonnet',
      effort: 'high',
      lowered: true,
    });
    expect(planAssignment({ kind: 'tests' }, ceiling).model).toBe('sonnet');

    for (const kind of ['design', 'investigation', 'review'] as const) {
      expect(planAssignment({ kind }, ceiling)).toMatchObject({
        model: 'claude-opus-5',
        effort: 'high',
        kind,
        lowered: false,
      });
    }
  });

  it('класса нет или он незнаком — работа идёт на потолке', () => {
    expect(planAssignment({}, ceiling)).toEqual({
      model: 'claude-opus-5',
      effort: 'high',
      lowered: false,
    });
    expect(planAssignment({ kind: 'рефакторинг' }, ceiling).model).toBe('claude-opus-5');
    expect(planAssignment({ kind: 'mechanical' }, { model: 'sonnet', effort: 'high' })).toEqual({
      model: 'sonnet',
      effort: 'high',
      lowered: false,
    });
    expect(planAssignment({ kind: 'mechanical' }, { model: '', effort: '' }).model).toBe('');
  });

  /**
   * Просьба агента — только вверх. Иначе «мне хватит haiku» стало бы решением
   * модели о самой себе, а понижение должно быть решением панели.
   */
  it('агент может просить больше, но не меньше', () => {
    // Модель поднялась до потолка, а глубина осталась классовой — работа всё
    // равно слабее потолка, и проверять её есть чем.
    expect(planAssignment({ kind: 'mechanical', model: 'opus' }, ceiling)).toMatchObject({
      model: 'claude-opus-5',
      effort: 'medium',
      lowered: true,
    });
    expect(planAssignment({ kind: 'implementation', effort: 'xhigh' }, ceiling).effort).toBe(
      'high',
    );
    expect(planAssignment({ kind: 'implementation', model: 'haiku' }, ceiling).model).toBe(
      'sonnet',
    );
    expect(planAssignment({ kind: 'mechanical', effort: 'low' }, ceiling).effort).toBe('medium');
    expect(planAssignment({ kind: 'design', model: 'haiku' }, ceiling).model).toBe('claude-opus-5');
  });

  it('большая группа механикой не бывает: ранг поднимается по фактам', () => {
    expect(planAssignment({ kind: 'mechanical', tasks: 5 }, ceiling)).toMatchObject({
      model: 'claude-opus-5',
      effort: 'high',
    });
    expect(planAssignment({ kind: 'mechanical', length: 4_001 }, ceiling).model).toBe(
      'claude-opus-5',
    );
    expect(planAssignment({ kind: 'mechanical', tasks: 4, length: 4_000 }, ceiling).model).toBe(
      'sonnet',
    );
  });

  it('перебором: план не ниже класса, не выше потолка и без max', () => {
    for (const model of CEILINGS) {
      for (const effort of EFFORT_CEILINGS) {
        const ceilingRank = ceilingModelRank(model);
        for (const kind of [...TASK_KINDS, 'нет такого', undefined]) {
          for (const wanted of WANTED) {
            const plan = planAssignment({ kind, model: wanted, tasks: 3 }, { model, effort });

            expect(plan.effort).not.toBe('max');

            const chosen = MODEL_RANK[plan.model as keyof typeof MODEL_RANK];
            if (chosen !== undefined && ceilingRank !== undefined) {
              expect(chosen).toBeLessThanOrEqual(ceilingRank);
              // Понижение только там, где панель сама так решила по классу.
              const floor = KIND_PLAN[kind as keyof typeof KIND_PLAN];
              if (chosen < ceilingRank)
                expect(chosen).toBeGreaterThanOrEqual(MODEL_RANK[floor!.model]);
            }
            // Пометка «проверить работу» и есть признак понижения.
            if (plan.lowered) expect(ceilingRank).not.toBeUndefined();
          }
        }
      }
    }
  });
});

describe('наборы для инструкции и карточки', () => {
  it('предлагать можно только то, что не выше потолка', () => {
    expect(assignableModelsUpTo('claude-opus-5')).toEqual(['haiku', 'sonnet', 'opus']);
    expect(assignableModelsUpTo('sonnet')).toEqual(['haiku', 'sonnet']);
    expect(assignableModelsUpTo('fable')).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(assignableEffortsUpTo('high')).toEqual(['low', 'medium', 'high']);
    expect(assignableEffortsUpTo('max')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(assignableEffortsUpTo('')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('нераспознанный потолок — пустой список: каскада нет', () => {
    expect(assignableModelsUpTo('')).toEqual([]);
    expect(assignableModelsUpTo('gpt-5-codex')).toEqual([]);
  });

  /**
   * Имя семейства ищется подстрокой, потому что потолок в настройках лежит
   * конкретным именем. Совпало несколько — берём младшее: строже безопаснее.
   */
  it('ранг потолка по имени модели', () => {
    expect(ceilingModelRank('claude-haiku-4-5-20251001')).toBe(MODEL_RANK.haiku);
    expect(ceilingModelRank('claude-sonnet-5')).toBe(MODEL_RANK.sonnet);
    expect(ceilingModelRank('claude-fable-5-1')).toBe(MODEL_RANK.fable);
    expect(ceilingModelRank('opus-sonnet-mix')).toBe(MODEL_RANK.sonnet);
    expect(ceilingModelRank('gemini-3-pro')).toBeUndefined();
  });
});

/**
 * Выбор ЧЕЛОВЕКА на карточке. Он отличается от просьбы агента ровно одним и в
 * этом весь смысл: агент может только поднимать (иначе «мне хватит haiku» стало
 * бы решением модели о самой себе), человек — и понижать тоже, потому что он
 * видел задачи группы и отвечает за результат.
 */
describe('ручная замена на карточке', () => {
  const ceiling = { model: 'claude-opus-5', effort: 'high' };

  it('понижает — то, чего подбор не делает никогда', () => {
    expect(manualAssignment({ model: 'haiku', effort: 'low' }, ceiling, 'design')).toEqual({
      model: 'haiku',
      effort: 'low',
      kind: 'design',
      lowered: true,
    });
    // Тот же класс через подбор остаётся на потолке: понижать `design` нельзя.
    expect(planAssignment({ kind: 'design' }, ceiling).model).toBe('claude-opus-5');
  });

  it('выше потолка не поднимает даже человека', () => {
    expect(manualAssignment({ model: 'fable', effort: 'xhigh' }, ceiling)).toEqual({
      model: 'claude-opus-5',
      effort: 'high',
      lowered: false,
    });
  });

  it('класс переживает замену: сменить модель — не сменить род работы', () => {
    expect(manualAssignment({ model: 'sonnet' }, ceiling, 'tests').kind).toBe('tests');
  });
});

/**
 * Обратное приведение имени к семейству. Нужно карточке: потолок бывает
 * конкретным именем, а список замены состоит из алиасов — без него выбранное
 * значение не нашлось бы в своём же списке.
 */
describe('семейство модели', () => {
  it('имя и алиас сводятся к одному', () => {
    expect(modelAlias('claude-opus-5')).toBe('opus');
    expect(modelAlias('claude-opus-5[1m]')).toBe('opus');
    expect(modelAlias('sonnet')).toBe('sonnet');
    expect(modelAlias('gpt-5')).toBeUndefined();
    expect(modelAlias('')).toBeUndefined();
  });

  it('у всего, что назначается, семейство есть — иначе select врал бы', () => {
    for (const model of ASSIGNABLE_MODELS) expect(modelAlias(model)).toBe(model);
  });
});

/** Разбор ручных замен с карточки: сюда приезжает JSON из браузера. */
describe('разбор ручных замен', () => {
  it('берёт только понятные значения', () => {
    const parsed = parseAssignments({
      0: { model: 'haiku', effort: 'low' },
      1: { model: 'gpt-5', effort: 'max' },
      2: { effort: 'high' },
    });

    expect(parsed.get(0)).toEqual({ model: 'haiku', effort: 'low' });
    // `max` не назначается никому, чужая модель не назначается вовсе — от
    // группы не остаётся ничего, и она идёт обычным подбором.
    expect(parsed.has(1)).toBe(false);
    expect(parsed.get(2)).toEqual({ effort: 'high' });
  });

  it('мусор не роняет разбор и ничего не назначает', () => {
    expect(parseAssignments(undefined).size).toBe(0);
    expect(parseAssignments('нет').size).toBe(0);
    expect(parseAssignments({ '-1': { model: 'opus' }, '99': { model: 'opus' } }).size).toBe(0);
    expect(parseAssignments({ 0: null, 1: 'opus', 2: {} }).size).toBe(0);
  });
});

describe('scanReviewBlocks', () => {
  const block = (body: string): string =>
    ['Разобрал дифф, вот что нашёл.', '', '```agentdeck:review', body, '```'].join('\n');

  it('вырезает блок из показа и отдаёт замечания', () => {
    const scan = scanReviewBlocks(block('{"findings":["ChatSplit.ts:88 — потеряна ошибка"]}'));

    expect(scan.text).toBe('Разобрал дифф, вот что нашёл.');
    expect(scan.findings).toEqual(['ChatSplit.ts:88 — потеряна ошибка']);
    expect(scan.rejected).toBe(0);
  });

  /**
   * Разница, ради которой вердикт вообще сделан блоком: «проверил, замечаний
   * нет» и «ревьюер не отчитался» — разные исходы. По первому цепочка
   * закрывается спокойно, по второму человек должен увидеть сам блок.
   */
  it('пустой список — это ответ, а отсутствие блока — нет', () => {
    expect(scanReviewBlocks(block('{"findings":[]}')).findings).toEqual([]);
    expect(scanReviewBlocks('Всё хорошо, замечаний нет.').findings).toBeUndefined();
  });

  it('сломанный JSON остаётся в тексте и считается отвергнутым', () => {
    const scan = scanReviewBlocks(block('{"findings":[«нет»]}'));

    expect(scan.findings).toBeUndefined();
    expect(scan.rejected).toBe(1);
    expect(scan.text).toContain('agentdeck:review');
  });

  it('незакрытый блок прячется целиком: лента не показывает голый JSON', () => {
    const scan = scanReviewBlocks('Итог:\n```agentdeck:review\n{"findings":["a"');

    expect(scan.text).toBe('Итог:');
    expect(scan.findings).toBeUndefined();
  });

  it('последний блок сильнее: агент вправе переписать вердикт до конца хода', () => {
    const scan = scanReviewBlocks(
      `${block('{"findings":["первое"]}')}\n${block('{"findings":[]}')}`,
    );

    expect(scan.findings).toEqual([]);
  });
});

describe('parseReviewFindings', () => {
  it('оставляет только непустые строки и режет по потолку длины', () => {
    const parsed = parseReviewFindings({ findings: ['  есть  ', '', 42, 'x'.repeat(900)] });

    expect(parsed?.slice(0, 2)).toEqual(['есть', 'x'.repeat(600)]);
  });

  it('не список замечаний — не вердикт', () => {
    expect(parseReviewFindings('нет')).toBeUndefined();
    expect(parseReviewFindings({ findings: 'одно' })).toBeUndefined();
    expect(parseReviewFindings(undefined)).toBeUndefined();
  });

  it('простыня обрезается: список уезжает заданием, а не отчётом', () => {
    const many = Array.from({ length: 50 }, (_, index) => `замечание ${index}`);

    expect(parseReviewFindings({ findings: many })).toHaveLength(20);
  });
});

describe('plannedRunCount', () => {
  /**
   * Цена согласия: у группы на потолке прогон один, у понижённой — до трёх
   * (работа, ревью, правки). Число показывается ДО кнопки.
   */
  it('понижённой группе считает три прогона, остальным — один', () => {
    expect(plannedRunCount([{ lowered: false }, { lowered: false }])).toBe(2);
    expect(plannedRunCount([{ lowered: true }, { lowered: false }])).toBe(4);
    expect(plannedRunCount([])).toBe(0);
  });
});

describe('тексты звеньев', () => {
  it('ревью запрещает правки и требует блок вердикта', () => {
    const prompt = reviewStagePrompt({ task: 'Переименуй foo в bar', model: 'sonnet' });

    expect(prompt).toContain('НИЧЕГО НЕ ПРАВЬ');
    expect(prompt).toContain(REVIEW_BLOCK_LANG);
    expect(prompt).toContain('Переименуй foo в bar');
  });

  it('правки перечисляют замечания по номерам и не зовут на второй заход', () => {
    const prompt = fixStagePrompt(['первое', 'второе'], 'split/rename');

    expect(prompt).toContain('1. первое');
    expect(prompt).toContain('2. второе');
    expect(prompt).toContain('split/rename');
  });

  /**
   * Этап 2 сдан — значит про ревью можно и НУЖНО говорить прямо: агент, знающий
   * о проверке, оставляет незаконченное незаконченным.
   */
  it('планка сдачи обещает ревью, а не только проверки проекта', () => {
    expect(loweredWorkPrompt('mechanical')).toContain('ревью');
  });
});
