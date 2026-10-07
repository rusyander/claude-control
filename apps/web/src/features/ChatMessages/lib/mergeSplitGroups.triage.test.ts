import { describe, it, expect } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { mergeSplitGroups, splitGroupKey } from './mergeSplitGroups';

type Group = SplitPlanView['groups'][number];

const group = (index: number, extra: Partial<Group> = {}): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'pending',
  ...extra,
});

/**
 * Ф16: посреди разбора разделения сервер отказывает «Запустить сейчас»
 * (`split-start-triage`) — порядок групп решит разбор. Строка хаба не должна
 * предлагать кнопку, которая заведомо получит отказ.
 */
describe('mergeSplitGroups — посреди разбора', () => {
  const triaging = (groups: Group[]): SplitPlanView => ({
    parentChatId: 'parent',
    triageChatId: 'triage-chat',
    order: groups.map((item) => item.index),
    groups,
  });

  it('ни одна строка не предлагает «Запустить сейчас» и «Пауза» очереди', () => {
    const rows = mergeSplitGroups(
      new Map<string, ChildStageGroup>([
        [
          splitGroupKey({ groupIndex: 1, id: 'c1' }),
          { chatId: 'c1', title: 'Группа 1', stages: ['work'], isRunning: false },
        ],
      ]),
      triaging([group(0), group(1, { chatId: 'c1' }), group(2, { seated: true })]),
    );
    const actions = rows.flatMap((row) => row.control?.actions ?? []);
    expect(actions).not.toContain('start');
    expect(actions).not.toContain('pause');
  });

  it('итог разбора пришёл — у ждущей группы кнопки снова есть', () => {
    const rows = mergeSplitGroups(new Map(), {
      ...triaging([group(0)]),
      triage: { at: '2026-10-05T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
    });
    expect(rows[0]?.control?.actions).toEqual(['start', 'pause']);
  });
});
