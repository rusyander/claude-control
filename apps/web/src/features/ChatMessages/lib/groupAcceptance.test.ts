/**
 * Кнопка приёмки в строке хаба: «Принять» у доставленной, «Отметить готовой»
 * у любой остановившейся (владелец 20.10), ничего — у идущей.
 */
import { describe, expect, it } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { acceptanceOf } from './groupAcceptance';

type Group = SplitPlanView['groups'][number];

const split = { parentChatId: 'p', groups: [] } as unknown as SplitPlanView;
const group = (status: Group['status'], extra: Partial<Group> = {}): Group =>
  ({ index: 2, title: 'г', branch: 'b', after: [], status, ...extra }) as Group;

describe('acceptanceOf', () => {
  it('доставленная — «Принять», без отметки «можно отметить готовой»', () => {
    expect(acceptanceOf(group('done'), split, false)).toEqual({
      acceptance: { parentChatId: 'p', index: 2 },
    });
  });

  it('остановленная, упавшая, ждущая человека — «Отметить готовой»', () => {
    for (const status of ['paused', 'failed', 'awaiting', 'pending'] as const) {
      expect(acceptanceOf(group(status), split, false).acceptance?.markable).toBe(true);
    }
  });

  it('идущая — кнопки нет: ход, фоновая команда или звено ещё работает', () => {
    expect(acceptanceOf(group('started'), split, false)).toEqual({});
    expect(acceptanceOf(group('background'), split, false)).toEqual({});
    expect(acceptanceOf(group('paused'), split, true)).toEqual({});
  });

  it('отмеченная вручную несёт время отметки — для снятия и для места внизу', () => {
    const marked = group('done', { acceptedAt: 'a', markedDoneAt: 'a' });
    expect(acceptanceOf(marked, split, false).acceptance).toMatchObject({
      acceptedAt: 'a',
      markedDoneAt: 'a',
    });
  });
});
