import { describe, it, expect } from 'vitest';
import { childAppendPrompt, stageAppendPrompt, stageOf } from './ChatCascadeStages.ts';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Что панель держит от конвейера звеньев после его переезда в ядро: стадию
 * сохранённой связи и дописку хода в чат такого звена — ту же, с которой звено
 * шло, собранную заново по СТАДИИ, а не скопированную у прошлого прогона.
 */

const SETTINGS = { handoffInitiative: true };

/** Связь понижённого ребёнка разделения, записанная до переезда. */
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

const append = (link: ChatLink): string => childAppendPrompt(link, SETTINGS);

describe('stageOf: стадия сохранённой связи', () => {
  it('известные стадии читаются как есть, пустая и незнакомая — работой', () => {
    for (const stage of ['triage', 'plan', 'review', 'fix', 'deliver'] as const) {
      expect(stageOf(workLink({ stage }))).toBe(stage);
    }
    expect(stageOf(workLink({ stage: undefined }))).toBe('work');
    expect(stageOf(workLink({ stage: 'verify' as never }))).toBe('work');
  });
});

describe('дописка хода в чат звена', () => {
  /**
   * Копировать дописку закончившегося прогона нельзя: у работы в ней лежит
   * планка сдачи «тебя ведёт модель ниже потолка», и в ревью эта строка сказала
   * бы проверяющему ровно обратное тому, зачем его завели.
   */
  it('ревью и доставка не получают планку сдачи, понижённая работа и правки получают', () => {
    expect(append(workLink({ stage: 'review' }))).not.toContain('BELOW the ceiling');
    expect(append(workLink({ stage: 'deliver' }))).not.toContain('BELOW the ceiling');
    expect(append(workLink())).toContain('BELOW the ceiling');
    expect(append(workLink({ stage: 'fix' }))).toContain('BELOW the ceiling');
    // Работа на потолке планку не несёт: сдавать проверке ниже потолка нечего.
    expect(append(workLink({ lowered: undefined }))).not.toContain('BELOW the ceiling');
  });

  it('правкам с замечаниями и ревьюером обещан проход проверки, без них — нет', () => {
    const verified = append(workLink({ stage: 'fix', fixFindings: ['a.ts:1 — забыт await'] }));
    const bare = append(workLink({ stage: 'fix' }));

    expect(verified).toContain('one verification pass over your fixes');
    expect(verified).not.toContain('nobody checks it but you');
    expect(bare).not.toContain('one verification pass over your fixes');
    // Задание правок само называло проверки проекта (TQ-10): планка ссылается на него.
    expect(verified).toContain('run the checks your task names, at the scope and moment it names');
  });

  it('делить звено дальше не предлагается: чат уже выделен под одну группу', () => {
    for (const stage of ['work', 'review', 'fix', 'deliver'] as const) {
      expect(append(workLink({ stage }))).not.toContain('agentdeck:split');
    }
  });

  it('ход в чат звена получает ту же дописку, что собрана по стадии связи, и строки группы', () => {
    const link = workLink({ stage: 'fix', fixFindings: ['F1'] });

    expect(childAppendPrompt(link, SETTINGS, 'Group line.')).toBe(
      stageAppendPrompt({ stage: 'fix', link }, SETTINGS, 'Group line.'),
    );
    expect(childAppendPrompt(link, SETTINGS, 'Group line.').endsWith('Group line.')).toBe(true);
  });
});
