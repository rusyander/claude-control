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
