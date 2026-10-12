import { describe, it, expect } from 'vitest';
import { planCascadeStage, stageAppendPrompt } from './ChatCascadeStages.ts';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Конвейер «работа → ревью → фикс»: что заводится после прогона и что НЕ
 * заводится. Второе тут важнее первого — цепочка, которая не умеет
 * останавливаться, тратит окно запросов сама на себя, а замечает это человек уже
 * по счётчику.
 */

/** Связь понижённого ребёнка разделения — то, что пишет `split-routes`. */
function workLink(patch: Partial<ChatLink> = {}): ChatLink {
  return {
    parentChatId: 'parent',
    createdAt: '2026-09-07T10:00:00.000Z',
    title: 'Переименования',
    branch: 'split/rename',
    model: 'sonnet',
    effort: 'medium',
    kind: 'mechanical',
    lowered: true,
    stage: 'work',
    ceilingModel: 'claude-opus-5',
    ceilingEffort: 'high',
    ...patch,
  };
}

const REVIEW_BLOCK = (body: string): string =>
  ['Проверил дифф.', '```agentdeck:review', body, '```'].join('\n');

function plan(input: Partial<Parameters<typeof planCascadeStage>[0]> = {}) {
  return planCascadeStage({
    link: workLink(),
    ok: true,
    text: '',
    task: 'Переименуй foo в bar по всем файлам',
    hasWork: () => true,
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    ...input,
  });
}

describe('planCascadeStage: после работы', () => {
  it('понижённая работа получает ревью на потолке', () => {
    const staged = plan();

    expect(staged?.stage).toBe('review');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.effort).toBe('high');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    // Модель работы едет в связь ревью: по ней вернутся правки.
    expect(staged?.link.workModel).toBe('sonnet');
    expect(staged?.link.workEffort).toBe('medium');
    // Ветвь дерева та же: три разговора одной группы висят под одним родителем.
    expect(staged?.link.parentChatId).toBe('parent');
    expect(staged?.link.branch).toBe('split/rename');
  });

  it('работа на потолке тоже получает ревью (U6): свежая сессия на той же модели', () => {
    const staged = plan({ link: workLink({ lowered: false }) });

    expect(staged?.stage).toBe('review');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.link.ceilingModel).toBe('claude-opus-5');
  });

  it('работа на потолке без записанного потолка читается своей же моделью', () => {
    const ceiling = workLink({ lowered: false, model: 'claude-opus-5', effort: 'xhigh' });
    delete ceiling.ceilingModel;
    delete ceiling.ceilingEffort;
    const staged = plan({ link: ceiling });

    expect(staged?.stage).toBe('review');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.effort).toBe('xhigh');
    // Записан потолком связи ревью: им же пойдёт проход проверки правок.
    expect(staged?.link).toMatchObject({ ceilingModel: 'claude-opus-5', ceilingEffort: 'xhigh' });
  });

  /**
   * Отметка одноразовая. Без неё второе сообщение человека в тот же чат заводило
   * бы ещё одну проверку — и так на каждый ход.
   */
  it('второе ревью той же работе не заводится', () => {
    expect(plan({ link: workLink({ reviewedAt: '2026-09-07T11:00:00.000Z' }) })).toBeUndefined();
  });

  it('пустой дифф работы на потолке проверять незачем', () => {
    expect(plan({ link: workLink({ lowered: false }), hasWork: () => false })).toBeUndefined();
  });

  /**
   * Понижённой работе обещано: упрёшься — остановись, работа продолжится на
   * модели сильнее (F4, 12.10.2026). Продолжения не было: пустой дифф кончал
   * цепочку «готово». Понижаются только механика, реализация и тесты — их итог
   * всегда дифф, и ход без единой правки и есть остановка.
   */
  it('понижённая работа без единой правки поднимается на потолок — один раз (F4)', () => {
    const staged = plan({
      link: workLink({ groupTask: 'Переименуй foo в bar по всем файлам' }),
      hasWork: () => false,
      text: 'Нужна миграция БД — это не механика, останавливаюсь.',
    });

    expect(staged?.stage).toBe('work');
    expect(staged?.model).toBe('claude-opus-5');
    expect(staged?.effort).toBe('high');
    expect(staged?.prompt).toContain('Переименуй foo в bar по всем файлам');
    expect(staged?.prompt).toContain('Нужна миграция БД');
    // Поднятая работа идёт на потолке: «ниже» и планка сдачи к ней не относятся.
    expect(staged?.link.lowered).toBeUndefined();
    expect(staged?.link.model).toBe('claude-opus-5');
    expect(staged?.link.stage).toBe('work');

    // Отметка «заведено» держит подъём одноразовым.
    expect(
      plan({ link: workLink({ plannedAt: '2026-09-07T11:00:00.000Z' }), hasWork: () => false }),
    ).toBeUndefined();
  });

  it('прогон кончился ошибкой — проверять нечего', () => {
    expect(plan({ ok: false })).toBeUndefined();
  });

  /**
   * Связь старше конвейера: потолка в ней нет, и завести проверку «на чём
   * придётся» нельзя — проверка слабее работы это не проверка.
   */
  it('без записанного потолка ревью не заводится', () => {
    const older = workLink();
    delete older.ceilingModel;

    expect(plan({ link: older })).toBeUndefined();
  });

  // U6: работа на потолке группы с доставкой идёт в ревью, доставку заводит его круг.
  it('работа на потолке группы с доставкой идёт в ревью, а не мимо него', () => {
    const staged = plan({ link: workLink({ lowered: false }), deliver: true });

    expect(staged?.stage).toBe('review');
    expect(staged?.link).toMatchObject({ stage: 'review', parentChatId: 'parent' });
  });

  it('связь без потолка у группы с доставкой тоже идёт в доставку', () => {
    const older = workLink();
    delete older.ceilingModel;
    const staged = plan({ link: older, deliver: true });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.prompt).toContain('it has no separate review');
  });

  it('пустую работу, паузу и второй круг без просьбы не доставляем; ревью — само доведёт', () => {
    const ceiling = workLink();
    delete ceiling.ceilingModel;
    expect(plan({ link: ceiling, deliver: true, hasWork: () => false })).toBeUndefined();
    expect(plan({ link: ceiling, deliver: true, paused: true })).toBeUndefined();
    const delivered = { ...ceiling, deliveredAt: '2026-09-07T11:00:00.000Z' };
    expect(plan({ link: delivered, deliver: true })).toBeUndefined();
    expect(plan({ link: delivered, deliver: true, redeliver: true })?.stage).toBe('deliver');
    // Ревью уже заведено на эту работу — доставку заводит его круг, не работа.
    const reviewed = workLink({ reviewedAt: '2026-09-07T11:00:00.000Z' });
    expect(plan({ link: reviewed, deliver: true })).toBeUndefined();
    // Понижённая работа по-прежнему идёт в ревью, а не мимо него.
    expect(plan({ deliver: true })?.stage).toBe('review');
  });

  it('обычный чат вне разделения конвейера не знает', () => {
    expect(planCascadeStage({ ok: true, text: '', task: '', hasWork: () => true })).toBeUndefined();
  });
});

describe('planCascadeStage: после ревью', () => {
  const reviewLink = (patch: Partial<ChatLink> = {}): ChatLink =>
    workLink({
      stage: 'review',
      model: 'claude-opus-5',
      effort: 'high',
      lowered: false,
      workModel: 'sonnet',
      workEffort: 'medium',
      ...patch,
    });

  it('замечания заводят правки на модели работы', () => {
    const staged = plan({
      link: reviewLink(),
      text: REVIEW_BLOCK('{"findings":["ChatSplit.ts:88 — потеряна ошибка"]}'),
    });

    expect(staged?.stage).toBe('fix');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.effort).toBe('medium');
    expect(staged?.findings).toEqual(['ChatSplit.ts:88 — потеряна ошибка']);
    expect(staged?.prompt).toContain('1. ChatSplit.ts:88 — потеряна ошибка');
  });

  it('пустой список закрывает цепочку', () => {
    expect(plan({ link: reviewLink(), text: REVIEW_BLOCK('{"findings":[]}') })).toBeUndefined();
  });

  /**
   * Ревьюер не отчитался в понятном виде. Заводить по такому ответу правки
   * нельзя: списка замечаний нет, и заданием станет пустота.
   */
  it('без блока вердикта правки не заводятся', () => {
    expect(plan({ link: reviewLink(), text: 'Всё хорошо, замечаний нет.' })).toBeUndefined();
  });

  it('правки — конец цепочки: второго круга ревью не бывает', () => {
    const staged = plan({
      link: reviewLink({ stage: 'fix' }),
      text: REVIEW_BLOCK('{"findings":["ещё одно"]}'),
    });

    expect(staged).toBeUndefined();
  });

  /**
   * Ревью чужого MR по ссылке (Т7) — не звено этого конвейера. Заведи он правки
   * сам, панель молча начала бы править чужую ветку по замечаниям, которых
   * человек ещё не видел. Решение там принимается кнопкой (`split-review.ts`).
   */
  it('ревью чужого MR по ссылке правок не заводит: там решает человек', () => {
    const staged = plan({
      link: reviewLink({ review: { url: 'https://gitlab.com/team/app/-/merge_requests/42' } }),
      text: REVIEW_BLOCK('{"findings":["src/a.ts:10 — забыт await"]}'),
    });

    expect(staged).toBeUndefined();
  });
});

/**
 * Проход проверки правок (U6, deep-review §7): один на круг, повтор
 * доказательства каждого замечания; его итог правок не заводит — открытое едет
 * в доставку и в MR.
 */
describe('planCascadeStage: проверка правок (U6)', () => {
  const FINDINGS = ['a.ts:3 — off by one', 'b.ts:9 — забыт await'];
  const fixLink = (patch: Partial<ChatLink> = {}): ChatLink =>
    workLink({
      stage: 'fix',
      workModel: 'sonnet',
      workEffort: 'medium',
      fixFindings: FINDINGS,
      ...patch,
    });

  it('правки несут замечания в связь — по ним пойдёт проверка', () => {
    const fix = plan({
      link: workLink({ stage: 'review', model: 'claude-opus-5', workModel: 'sonnet' }),
      text: REVIEW_BLOCK(JSON.stringify({ findings: FINDINGS })),
    });

    expect(fix?.stage).toBe('fix');
    expect(fix?.link.fixFindings).toEqual(FINDINGS);
    expect(fix?.link.ceilingModel).toBe('claude-opus-5');
  });

  it('конец правок заводит ОДИН проход проверки на ревьюере, а не доставку', () => {
    const verify = plan({ link: fixLink(), text: 'Поправил оба.', deliver: true });

    expect(verify?.stage).toBe('review');
    expect(verify?.model).toBe('claude-opus-5');
    expect(verify?.effort).toBe('high');
    expect(verify?.prompt).toContain('VERIFYING those fixes');
    expect(verify?.prompt).toContain('Attempted is not fixed');
    expect(verify?.prompt).toContain('1. a.ts:3 — off by one');
    expect(verify?.prompt).toContain('2. b.ts:9 — забыт await');
    expect(verify?.prompt).toContain('Поправил оба.');
    expect(verify?.link).toMatchObject({
      stage: 'review',
      fixFindings: FINDINGS,
      workModel: 'sonnet',
      parentChatId: 'parent',
    });
  });

  it('проверка уже заведена — второй не будет, и доставку правки не заводят', () => {
    const reviewed = fixLink({ reviewedAt: '2026-09-07T11:00:00.000Z' });

    expect(plan({ link: reviewed, deliver: true })).toBeUndefined();
  });

  it('ход правок с вопросом — ни проверки, ни доставки', () => {
    expect(plan({ link: fixLink(), deliver: true, paused: true })).toBeUndefined();
  });

  it('связь правок до U6 (без замечаний) — в доставку, как раньше', () => {
    const legacy = fixLink();
    delete legacy.fixFindings;

    expect(plan({ link: legacy, deliver: true })?.stage).toBe('deliver');
  });

  it('замечания без записанного ревьюера — проверять некем: сразу в доставку', () => {
    const orphan = fixLink();
    delete orphan.ceilingModel;
    delete orphan.ceilingEffort;

    expect(plan({ link: orphan, deliver: true })?.stage).toBe('deliver');
  });

  const verifyLink = (): ChatLink =>
    workLink({
      stage: 'review',
      model: 'claude-opus-5',
      lowered: false,
      workModel: 'sonnet',
      fixFindings: FINDINGS,
    });

  it('открытое после проверки едет в доставку как открытое, правок не заводит', () => {
    const staged = plan({
      link: verifyLink(),
      text: REVIEW_BLOCK('{"findings":["b.ts:9 — await всё ещё забыт"]}'),
      deliver: true,
    });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.prompt).toContain('verification pass re-checked them');
    expect(staged?.prompt).toContain('Open after verification');
    expect(staged?.prompt).toContain('1. b.ts:9 — await всё ещё забыт');
  });

  it('всё подтверждено — доставка без раздела открытого', () => {
    const staged = plan({
      link: verifyLink(),
      text: REVIEW_BLOCK('{"findings":[]}'),
      deliver: true,
    });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.prompt).toContain('verification pass re-checked them');
    expect(staged?.prompt).not.toContain('Open after verification');
    expect(staged?.prompt).not.toContain('NOT verified');
  });

  it('проверка без блока итога — доставка говорит в MR, что правки не проверены', () => {
    const staged = plan({ link: verifyLink(), text: 'Вроде всё ок.', deliver: true });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.prompt).toContain('the review fixes were NOT verified');
  });

  it('без доставки проверка кончает цепочку: второго круга правок нет', () => {
    expect(
      plan({ link: verifyLink(), text: REVIEW_BLOCK('{"findings":["ещё открыто"]}') }),
    ).toBeUndefined();
  });

  it('правкам обещана проверка, а не «тебя никто не проверит»', () => {
    const settings = { taskSplitInitiative: true, handoffInitiative: true };
    const fix = plan({
      link: workLink({ stage: 'review', model: 'claude-opus-5', workModel: 'sonnet' }),
      text: REVIEW_BLOCK(JSON.stringify({ findings: FINDINGS })),
    });
    const append = fix ? stageAppendPrompt(fix, settings) : '';

    expect(append).toContain('one verification pass over your fixes');
    expect(append).not.toContain('nobody checks it but you');
    expect(fix?.prompt).toContain('the panel starts one verification pass');
  });
});

describe('stageAppendPrompt', () => {
  const settings = { taskSplitInitiative: true, handoffInitiative: true };

  /**
   * Копировать дописку закончившегося прогона нельзя: у работы в ней лежит
   * планка сдачи «тебя ведёт модель ниже потолка», и в ревью эта строка сказала
   * бы проверяющему ровно обратное тому, зачем его завели.
   */
  it('ревью не получает планку сдачи, правки получают', () => {
    const review = plan();
    const fix = plan({
      link: workLink({ stage: 'review', workModel: 'sonnet', workEffort: 'medium' }),
      text: REVIEW_BLOCK('{"findings":["поправь"]}'),
    });

    expect(review && stageAppendPrompt(review, settings)).not.toContain('BELOW the ceiling');
    expect(fix && stageAppendPrompt(fix, settings)).toContain('BELOW the ceiling');
  });

  /**
   * TQ-10 (12.10.2026): задание правок само определяет проверки проекта, и
   * планка сдачи того же прогона повторяла определение слово в слово.
   */
  it('правки: определение проверок проекта в прогоне один раз, планка ссылается на задание', () => {
    const fix = plan({
      link: workLink({ stage: 'review', workModel: 'sonnet', workEffort: 'medium' }),
      text: REVIEW_BLOCK('{"findings":["поправь"]}'),
    });
    const run = `${fix ? stageAppendPrompt(fix, settings) : ''}\n${fix?.prompt ?? ''}`;

    expect(run.split('run the project checks its rules name').length - 1).toBe(1);
    expect(run).toContain('run the project checks your task names');
  });

  it('делить звено дальше не предлагается: чат уже выделен под одну группу', () => {
    const review = plan();

    expect(review && stageAppendPrompt(review, settings)).not.toContain('agentdeck:split');
  });
});

/**
 * Уровни разделения (Т1): после плана заводится работа — единственное звено,
 * которое стартует и после неудачи; разбор звеньев не заводит вовсе.
 */
describe('planCascadeStage: после плана и разбора', () => {
  const PLAN_BLOCK = (body: string): string =>
    ['Изучил.', '```agentdeck:plan', body, '```'].join('\n');

  const planLink = (patch: Partial<ChatLink> = {}): ChatLink =>
    workLink({
      stage: 'plan',
      model: 'claude-opus-5',
      effort: 'high',
      workModel: 'sonnet',
      workEffort: 'medium',
      lowered: true,
      task: 'Переименуй foo в bar',
      owns: ['src/rename'],
      notes: 'api.ts — у соседей',
      ...patch,
    });

  // Владелец 12.10.2026: ревью, правки и доставка сверяют работу с планом и
  // заданием — огрызок в 4k без критериев приёмки сверять не с чем.
  it('длинный план и задание доходят до следующих звеньев целиком', () => {
    const longPlan = `${'1. Шаг с проверкой после него.\n'.repeat(400)}## Критерии приёмки\n- всё зелёное`;
    const longTask = `${'Переименуй foo в bar везде. '.repeat(1_000)}ХВОСТ ЗАДАНИЯ`;
    const staged = plan({ link: planLink({ task: longTask }), text: PLAN_BLOCK(longPlan) });

    expect(staged?.link.planSummary).toBe(longPlan);
    expect(staged?.link.task).toBe(longTask);
    expect(staged?.prompt).toContain('## Критерии приёмки');
    expect(staged?.prompt).toContain('ХВОСТ ЗАДАНИЯ');
  });

  it('план кончился — работа на подобранной модели с планом, границами и заметками', () => {
    const staged = plan({ link: planLink(), text: PLAN_BLOCK('## Шаги\n1. Найти foo') });

    expect(staged?.stage).toBe('work');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.effort).toBe('medium');
    expect(staged?.planMissing).toBeUndefined();
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('1. Найти foo');
    expect(staged?.prompt).toContain('src/rename');
    expect(staged?.prompt).toContain('api.ts — у соседей');
    // Связь работы: понижена, с потолком и задачей — ревью после неё идёт как обычно.
    expect(staged?.link).toMatchObject({
      stage: 'work',
      model: 'sonnet',
      effort: 'medium',
      lowered: true,
      ceilingModel: 'claude-opus-5',
      owns: ['src/rename'],
    });
  });

  it('план без блока или упавший — работа всё равно стартует, с пометкой planMissing', () => {
    const noBlock = plan({ link: planLink(), text: 'Ничего не понял.' });
    const failed = plan({ link: planLink(), ok: false, text: '' });

    expect(noBlock?.stage).toBe('work');
    expect(noBlock?.planMissing).toBe(true);
    expect(noBlock?.prompt).toContain('The panel did not receive');
    expect(failed?.stage).toBe('work');
    expect(failed?.planMissing).toBe(true);
  });

  it('план на потолке — работа не понижена и планки сдачи не получает', () => {
    const staged = plan({
      link: planLink({ workModel: 'claude-opus-5', workEffort: 'high', lowered: false }),
      text: PLAN_BLOCK('план'),
    });

    expect(staged?.link.lowered).toBeUndefined();
    expect(
      staged && stageAppendPrompt(staged, { taskSplitInitiative: true, handoffInitiative: true }),
    ).not.toContain('BELOW the ceiling');
  });

  it('понижённая работа после плана получает планку сдачи', () => {
    const staged = plan({ link: planLink(), text: PLAN_BLOCK('план') });

    expect(
      staged && stageAppendPrompt(staged, { taskSplitInitiative: true, handoffInitiative: true }),
    ).toContain('BELOW the ceiling');
  });

  it('план отработан один раз: с отметкой plannedAt вторая работа не заводится', () => {
    expect(
      plan({ link: planLink({ plannedAt: '2026-09-09T10:00:00.000Z' }), text: PLAN_BLOCK('п') }),
    ).toBeUndefined();
  });

  it('разбор (уровень 1) звеньев не заводит: его итог применяет конвейер', () => {
    expect(plan({ link: workLink({ stage: 'triage' }), text: 'что угодно' })).toBeUndefined();
  });
});

/**
 * Аудит 25.09, L238: чат группы перенаправляется на звено, и ревью, правки и
 * доставка начинали с нуля — без задания, плана и итога прошлого звена.
 */
describe('planCascadeStage: контекст следующего звена', () => {
  const PLAN = '## Шаги\n1. Найти foo\n2. Заменить на bar';

  it('план кладёт выжимку в связь работы, и она едет до ревью', () => {
    const afterPlan = plan({
      link: workLink({ stage: 'plan', lowered: true, workModel: 'sonnet', task: 'Переименуй foo' }),
      text: ['```agentdeck:plan', PLAN, '```'].join('\n'),
    });
    expect(afterPlan?.link.planSummary).toContain('1. Найти foo');

    const review = plan({
      link: afterPlan!.link,
      text: 'Сделал: переименовал в 12 файлах.',
    });
    expect(review?.stage).toBe('review');
    expect(review?.prompt).toContain('1. Найти foo');
    expect(review?.prompt).toContain('переименовал в 12 файлах');
    expect(review?.link).toMatchObject({
      task: 'Переименуй foo',
      planSummary: afterPlan!.link.planSummary,
    });
  });

  it('правки получают задание, план, ветку и вывод ревью; связь несёт их дальше', () => {
    const staged = plan({
      link: workLink({
        stage: 'review',
        model: 'claude-opus-5',
        lowered: false,
        workModel: 'sonnet',
        task: 'Переименуй foo в bar',
        planSummary: PLAN,
      }),
      text: [
        'Ревьюер: переименование неполное.',
        '```agentdeck:review',
        '{"findings":["b.ts:3 — остался foo"]}',
        '```',
      ].join('\n'),
      deliver: true,
    });
    expect(staged?.stage).toBe('fix');
    expect(staged?.prompt).toContain('Group task:');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('2. Заменить на bar');
    expect(staged?.prompt).toContain('Group branch: split/rename.');
    expect(staged?.prompt).toContain('Outcome of the previous stage (review):');
    expect(staged?.prompt).toContain('переименование неполное');
    expect(staged?.link).toMatchObject({ task: 'Переименуй foo в bar', planSummary: PLAN });
    // Аудит 25.09, L258: не воспроизвелось — не повод тянуть инфраструктуру.
    expect(staged?.prompt).toContain('is no reason to change infrastructure');
  });

  it('доставка после правок знает задание и итог правок и перечитывает обсуждения MR', () => {
    const staged = plan({
      link: workLink({ stage: 'fix', task: 'Переименуй foo в bar', planSummary: PLAN }),
      text: 'Поправил b.ts, тесты зелёные.',
      deliver: true,
    });
    expect(staged?.stage).toBe('deliver');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('Outcome of the previous stage (fixes):');
    expect(staged?.prompt).toContain('Поправил b.ts');
    // Аудит 25.09, L199: «готово» по MR — только после всех его обсуждений.
    expect(staged?.prompt).toContain('re-read ALL discussions of the MR');
    // Аудит 25.09, L163: дифф сверяется с заданием, шаг за его границу — вопросом.
    expect(staged?.prompt).toContain('Compare the diff of the branch against main');
    expect(staged?.prompt).toContain('a step beyond the tasks of the group');
    // Контекст есть — «контекста у тебя нет» задание не говорит.
    expect(staged?.prompt).not.toContain('you have no context of the previous stages');
  });
});

describe('planCascadeStage: сита перед MR', () => {
  const SIEVES = (body: string): string => ['```agentdeck:sieves', body, '```'].join('\n');
  const calls: { stage: string; done: string[] }[] = [];
  const sieves = (stage: 'review' | 'deliver', done: readonly { id: string }[]): string => {
    calls.push({ stage, done: done.map((row) => row.id) });
    return `SIEVES-${stage.toUpperCase()}`;
  };

  it('ревью получает абзац своих сит, строки работы едут в связь ревью', () => {
    calls.length = 0;
    const staged = plan({
      text: `Сделал.\n${SIEVES('{"sieves":[{"id":"merge-tree","status":"pass","evidence":"git merge-tree → clean"}]}')}`,
      sieves,
    });
    expect(staged?.stage).toBe('review');
    expect(staged?.prompt).toContain('SIEVES-REVIEW');
    expect(calls).toEqual([{ stage: 'review', done: ['merge-tree'] }]);
    expect(staged?.link.sieveRows?.map((row) => row.id)).toEqual(['merge-tree']);
  });

  it('правки несут строки ревью дальше, доставка видит все и получает свой абзац', () => {
    calls.length = 0;
    const review = [
      'Проверил дифф.',
      '```agentdeck:review',
      '{"findings":["a.ts:3 — off by one"]}',
      '```',
      SIEVES(
        '{"sieves":[{"id":"contract-by-request","status":"pass","evidence":"curl /api/x → 404 as in docs"}]}',
      ),
    ].join('\n');
    const fix = plan({
      link: workLink({
        stage: 'review',
        workModel: 'sonnet',
        sieveRows: [{ id: 'merge-tree', status: 'pass', evidence: 'git merge-tree → clean' }],
      }),
      text: review,
      deliver: true,
      sieves,
    });
    expect(fix?.stage).toBe('fix');
    expect(fix?.link.sieveRows?.map((row) => row.id)).toEqual([
      'merge-tree',
      'contract-by-request',
    ]);
    if (!fix) return;
    // За правками — проход проверки (U6); строки едут и через него.
    const verify = plan({ link: fix.link, text: 'Поправил a.ts.', deliver: true, sieves });
    expect(verify?.stage).toBe('review');
    expect(verify?.link.sieveRows).toHaveLength(2);
    if (!verify) return;
    const deliver = plan({
      link: verify.link,
      text: REVIEW_BLOCK('{"findings":[]}'),
      deliver: true,
      sieves,
    });
    expect(deliver?.stage).toBe('deliver');
    expect(deliver?.prompt).toContain('SIEVES-DELIVER');
    expect(calls.at(-1)).toEqual({
      stage: 'deliver',
      done: ['merge-tree', 'contract-by-request'],
    });
    expect(deliver?.link.sieveRows).toHaveLength(2);
  });

  it('без поставщика сит задание звена прежнее', () => {
    expect(plan()?.prompt).not.toContain('SIEVES-');
  });
});
