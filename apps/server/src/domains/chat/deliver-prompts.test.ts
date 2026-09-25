import { describe, it, expect } from 'vitest';
import { deliverStagePrompt, fixStagePrompt } from '@agentdeck/contracts/model-cascade';
import { deliveryPreamble } from '@agentdeck/contracts/task-split';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { asksDelivery, planCascadeStage } from './ChatCascadeStages.ts';
import { CHILD_PROMPT } from './initiative.ts';
import { SplitConveyor, deliveryNudgePrompt, type SplitConveyorDeps } from './split-conveyor.ts';

/**
 * Тексты доставки группы разделения (журнал 59d, 61b, 78): что звенья читают
 * про коммит, свежую основную ветку и право решать без человека.
 */

describe('правки группы с доставкой (журнал 59d)', () => {
  it('ограничение правок — про код: доставку оно не запрещает', () => {
    const prompt = fixStagePrompt(['поправь a.ts:1'], { branch: 'split/x', deliver: true });

    expect(prompt).not.toContain('Ничего сверх списка');
    expect(prompt).toContain('Код сверх списка не переделывай');
    expect(prompt).toContain('коммит, пуш и MR им не запрещены');
  });

  it('правки без доставки про доставку не говорят ничего (ревью по ссылке, Т7)', () => {
    const prompt = fixStagePrompt(['поправь a.ts:1'], { branch: 'split/x' });

    expect(prompt).not.toContain('MR');
  });
});

describe('звено доставки (журнал 59a, 61b)', () => {
  const prompt = deliverStagePrompt({ branch: 'fix-PROJ-7', after: 'fix' });

  it('свежая основная ветка до пуша: fetch и rebase неотправленной ветки', () => {
    expect(prompt).toContain('git fetch origin');
    expect(prompt).toContain('git rebase origin/<основная>');
    // Отправленную отставшую — тоже, но пуш только с арендой (W3-3); `--force` — никогда.
    expect(prompt).toContain('force-push без аренды (`--force`) запрещён всегда');
  });

  it('конфликт с решением за человеком — вопрос инструментом, а не отчёт', () => {
    expect(prompt).toContain('AskUserQuestion');
  });

  it('группа без звена доставки (работа на потолке) тоже берёт свежую основную до пуша', () => {
    const preamble = deliveryPreamble({ branch: 'fix-PROJ-7' });

    expect(preamble).toContain('git fetch origin');
    expect(preamble).toContain('rebase ветки на свежую основную');
  });

  it('пуш своей ветки обычным push, MR и ссылка последней строкой', () => {
    expect(prompt).toContain('git push -u origin fix-PROJ-7');
    expect(prompt).toContain('Последней строкой ответа — ссылка на MR');
  });
});

describe('группа решает сама (журнал 78, T24)', () => {
  it('правила ребёнка велят брать рекомендуемый вариант и называть его', () => {
    expect(CHILD_PROMPT).toContain('рекомендуемый');
    expect(CHILD_PROMPT).toContain('необратим');
  });

  it('доставка группы не останавливается на «неясно, чего хотят», если есть рекомендация', () => {
    const preamble = deliveryPreamble({ branch: 'fix-PROJ-7' });

    expect(preamble).toContain('рекомендуемый');
    expect(preamble).not.toContain('неясно, чего хотят) — вопрос человеку');
  });
});

describe('SplitConveyor.delivers', () => {
  function conveyorWith(record: SplitPlanRecord): SplitConveyor {
    return new SplitConveyor({
      store: {
        get: (parent: string) => (parent === record.parentChatId ? record : undefined),
        set: () => undefined,
        findByTriage: () => undefined,
        all: () => ({ [record.parentChatId]: record }),
      },
      log: () => undefined,
    } as unknown as SplitConveyorDeps);
  }

  const record = {
    parentChatId: 'родитель',
    projectPath: 'C:/repo',
    createdAt: '2026-09-24T00:00:00.000Z',
    order: [0, 1],
    request: {},
    proposal: { groups: [] },
    groups: [
      { index: 0, branch: 'fix-PROJ-7', status: 'started', deliver: true },
      { index: 1, branch: 'fix-PROJ-8', status: 'started' },
    ],
  } as unknown as SplitPlanRecord;

  it('группа с доставкой — да, без неё и без записи — нет', () => {
    const conveyor = conveyorWith(record);

    expect(conveyor.delivers({ parentChatId: 'родитель', createdAt: '', groupIndex: 0 })).toBe(
      true,
    );
    expect(conveyor.delivers({ parentChatId: 'родитель', createdAt: '', groupIndex: 1 })).toBe(
      false,
    );
    expect(
      conveyor.delivers({ parentChatId: 'родитель', createdAt: '', branch: 'fix-PROJ-7' }),
    ).toBe(true);
    expect(conveyor.delivers({ parentChatId: 'чужой', createdAt: '', groupIndex: 0 })).toBe(false);
  });
});

describe('доставка раз на круг (W3-3)', () => {
  it('просьба человека — повелительное «доставь», «доведи до MR», «повтори доставку»', () => {
    expect(asksDelivery('Доставь ещё раз: MR не обновился')).toBe(true);
    expect(asksDelivery('доведи до MR, пожалуйста')).toBe(true);
    expect(asksDelivery('Повтори доставку')).toBe(true);
    expect(asksDelivery('please deliver again')).toBe(true);
  });

  it('задания панели и рассказ про MR повтором не считаются', () => {
    expect(asksDelivery(deliveryNudgePrompt('fix-PROJ-7', ['нет MR']))).toBe(false);
    expect(asksDelivery(fixStagePrompt(['a.ts:1'], { deliver: true }))).toBe(false);
    expect(asksDelivery(deliverStagePrompt({ branch: 'fix-PROJ-7', after: 'fix' }))).toBe(false);
    expect(asksDelivery('А тесты точно прошли? MR уже открыт?')).toBe(false);
    expect(asksDelivery('доставка сломалась?')).toBe(false);
  });

  it('чистое ревью, после которого доставка уже заведена, второй не заводит', () => {
    const verdict = ['```agentdeck:review', '{"findings":[]}', '```'].join('\n');
    const link = {
      parentChatId: 'родитель',
      createdAt: '2026-09-25T10:00:00.000Z',
      stage: 'review',
      model: 'claude-opus-5',
      workModel: 'sonnet',
      deliveredAt: '2026-09-25T11:00:00.000Z',
    };
    const input = { link, ok: true, text: verdict, task: '', hasWork: () => true, deliver: true };

    expect(planCascadeStage(input)).toBeUndefined();
    expect(planCascadeStage({ ...input, redeliver: true })?.stage).toBe('deliver');
  });
});
