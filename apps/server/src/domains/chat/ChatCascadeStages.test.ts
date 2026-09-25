import { describe, it, expect } from 'vitest';
import { planCascadeStage, stageAppendPrompt } from './ChatCascadeStages.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';

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

  it('работа на потолке ревью не получает: усиливать нечем', () => {
    expect(plan({ link: workLink({ lowered: false }) })).toBeUndefined();
  });

  /**
   * Отметка одноразовая. Без неё второе сообщение человека в тот же чат заводило
   * бы ещё одну проверку — и так на каждый ход.
   */
  it('второе ревью той же работе не заводится', () => {
    expect(plan({ link: workLink({ reviewedAt: '2026-09-07T11:00:00.000Z' }) })).toBeUndefined();
  });

  it('пустой дифф проверять незачем', () => {
    expect(plan({ hasWork: () => false })).toBeUndefined();
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

  // M8: ревью этой работе не положено — группа с доставкой идёт в доставку сразу.
  it('работа на потолке группы с доставкой заводит доставку на модели работы', () => {
    const staged = plan({ link: workLink({ lowered: false }), deliver: true });

    expect(staged?.stage).toBe('deliver');
    expect(staged?.model).toBe('sonnet');
    expect(staged?.prompt).toContain('отдельного ревью у неё нет');
    expect(staged?.link).toMatchObject({ stage: 'deliver', parentChatId: 'parent' });
  });

  it('связь без потолка у группы с доставкой тоже идёт в доставку', () => {
    const older = workLink();
    delete older.ceilingModel;

    expect(plan({ link: older, deliver: true })?.stage).toBe('deliver');
  });

  it('пустую работу, паузу и второй круг без просьбы не доставляем; ревью — само доведёт', () => {
    const ceiling = workLink({ lowered: false });
    expect(plan({ link: ceiling, deliver: true, hasWork: () => false })).toBeUndefined();
    expect(plan({ link: ceiling, deliver: true, paused: true })).toBeUndefined();
    const delivered = workLink({ lowered: false, deliveredAt: '2026-09-07T11:00:00.000Z' });
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

    expect(review && stageAppendPrompt(review, settings)).not.toContain('НИЖЕ потолка');
    expect(fix && stageAppendPrompt(fix, settings)).toContain('НИЖЕ потолка');
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
    expect(noBlock?.prompt).toContain('панель не получила');
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
    ).not.toContain('НИЖЕ потолка');
  });

  it('понижённая работа после плана получает планку сдачи', () => {
    const staged = plan({ link: planLink(), text: PLAN_BLOCK('план') });

    expect(
      staged && stageAppendPrompt(staged, { taskSplitInitiative: true, handoffInitiative: true }),
    ).toContain('НИЖЕ потолка');
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
    expect(staged?.prompt).toContain('Задание группы:');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('2. Заменить на bar');
    expect(staged?.prompt).toContain('Ветка группы: split/rename.');
    expect(staged?.prompt).toContain('Итог прошлого звена (ревью):');
    expect(staged?.prompt).toContain('переименование неполное');
    expect(staged?.link).toMatchObject({ task: 'Переименуй foo в bar', planSummary: PLAN });
    // Аудит 25.09, L258: не воспроизвелось — не повод тянуть инфраструктуру.
    expect(staged?.prompt).toContain('не повод менять инфраструктуру');
  });

  it('доставка после правок знает задание и итог правок и перечитывает обсуждения MR', () => {
    const staged = plan({
      link: workLink({ stage: 'fix', task: 'Переименуй foo в bar', planSummary: PLAN }),
      text: 'Поправил b.ts, тесты зелёные.',
      deliver: true,
    });
    expect(staged?.stage).toBe('deliver');
    expect(staged?.prompt).toContain('Переименуй foo в bar');
    expect(staged?.prompt).toContain('Итог прошлого звена (правки):');
    expect(staged?.prompt).toContain('Поправил b.ts');
    // Аудит 25.09, L199: «готово» по MR — только после всех его обсуждений.
    expect(staged?.prompt).toContain('перечитай ВСЕ обсуждения MR');
    // Аудит 25.09, L163: дифф сверяется с заданием, шаг за его границу — вопросом.
    expect(staged?.prompt).toContain('Сверь дифф ветки с основной');
    expect(staged?.prompt).toContain('выходит за задачи группы');
    // Контекст есть — «контекста у тебя нет» задание не говорит.
    expect(staged?.prompt).not.toContain('контекста прошлых звеньев у тебя нет');
  });
});
