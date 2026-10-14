import { describe, it, expect, vi } from 'vitest';
import type { SplitGroupReviewClose } from '@agentdeck/contracts/chat-handoff';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { SplitConveyor } from './split-conveyor.ts';

/**
 * @covers apps/server/src/domains/chat/split-conveyor/split-conveyor.ts
 * @scenario Группа ревью по ссылке закрылась — панель сверяет копию и убирает
 * за ней (T13, T6/T11, T7): итог ложится в запись и в хаб, одноразовая база
 * снимается, обычная группа и сбой уборки закрытие не меняют.
 */

const STAND = { name: 'agentdeck-review-abc123', image: 'postgres:16.4', startedAt: '' };
const CLOSE: SplitGroupReviewClose = {
  at: '2026-10-13T12:00:00.000Z',
  dirt: { total: 1, files: ['notes.md'] },
  standRemoved: true,
};

const LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '',
  branch: 'review/mr',
  groupIndex: 0,
  stage: 'review',
};

function triageDone(): RunFinished {
  return {
    chatId: 'triage',
    projectPath: 'C:/repo',
    text: 'Ничего не нашёл.',
    ok: true,
    startedAt: 1,
    options: { prompt: '', cwd: 'C:/repo' },
    contextTokens: 0,
  };
}

function build(options: {
  review: boolean;
  closeReview?: NonNullable<ConstructorParameters<typeof SplitConveyor>[0]['closeReview']>;
}) {
  const records = new Map<string, SplitPlanRecord>();
  const logs: string[] = [];
  const proposal = {
    shared: '',
    groups: [
      {
        title: 'Ревью',
        branch: 'review/mr',
        tasks: ['посмотри'],
        ...(options.review
          ? { review: { url: 'https://tracker.example.com/x/-/merge_requests/1' } }
          : {}),
      },
    ],
  };
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => records.get(parent),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        [...records.values()].find((record) => ids.includes(record.triageChatId ?? '')),
      all: () => Object.fromEntries(records),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: 'Ревью',
        branch: record.groups[index]?.branch ?? '',
        chatId: 'work-1',
        path: 'C:/copies/0',
        isWorktree: true,
        started: true,
        prompt: '',
        ...(options.review ? { reviewStand: STAND } : {}),
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    ...(options.closeReview ? { closeReview: options.closeReview } : {}),
    log: (message) => void logs.push(message),
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  });
  const start = async () => {
    await conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal,
      request: {},
    });
    conveyor.onTriageFinished(triageDone(), ['triage']);
    await new Promise((done) => setTimeout(done, 20));
  };
  return { conveyor, records, start, logs, view: () => conveyor.view(['родитель'])?.groups[0] };
}

describe('SplitConveyor: закрытие группы ревью', () => {
  it('итог по копии ложится в запись и в хаб; снятая база забыта', async () => {
    const calls: { dirt: boolean; stand?: string }[] = [];
    const { conveyor, records, start, view } = build({
      review: true,
      closeReview: async (_record, group, options) => {
        calls.push({ dirt: options.dirt, ...(group.stand ? { stand: group.stand.name } : {}) });
        return CLOSE;
      },
    });
    await start();
    expect(records.get('родитель')?.groups[0]?.stand).toEqual(STAND);

    conveyor.onChainEnded(LINK, { status: 'done', result: { kind: 'reviewed' } });
    await vi.waitFor(() => expect(records.get('родитель')?.groups[0]?.reviewClose).toEqual(CLOSE));

    expect(calls).toEqual([{ dirt: true, stand: STAND.name }]);
    expect(records.get('родитель')?.groups[0]?.stand).toBeUndefined();
    expect(view()).toMatchObject({ status: 'done', reviewClose: CLOSE });
  });

  it('база не снялась — запись о ней остаётся: следующая уборка её найдёт', async () => {
    const { conveyor, records, start } = build({
      review: true,
      closeReview: async () => ({
        at: CLOSE.at,
        dirt: CLOSE.dirt as { total: number; files: string[] },
      }),
    });
    await start();

    conveyor.onChainEnded(LINK, { status: 'done', result: { kind: 'reviewed' } });
    await vi.waitFor(() => expect(records.get('родитель')?.groups[0]?.reviewClose).toBeDefined());

    expect(records.get('родитель')?.groups[0]?.stand).toEqual(STAND);
  });

  it('ревью чинило по решению человека — git status не нужен, база и копии убираются всё равно', async () => {
    const calls: boolean[] = [];
    const { conveyor, start } = build({
      review: true,
      closeReview: async (_record, _group, options) => {
        calls.push(options.dirt);
        return { at: CLOSE.at, standRemoved: true };
      },
    });
    await start();

    conveyor.onChainEnded(LINK, { status: 'done', result: { kind: 'pushed' } });
    await vi.waitFor(() => expect(calls).toEqual([false]));
  });

  it('обычная группа: уборка не зовётся', async () => {
    const closeReview = vi.fn(async () => CLOSE);
    const { conveyor, start, records } = build({ review: false, closeReview });
    await start();

    conveyor.onChainEnded(LINK, { status: 'done' });
    await new Promise((done) => setTimeout(done, 40));

    expect(closeReview).not.toHaveBeenCalled();
    expect(records.get('родитель')?.groups[0]?.reviewClose).toBeUndefined();
  });

  it('уборка упала — группа закрыта как была, сбой в журнале', async () => {
    const { conveyor, start, logs, view } = build({
      review: true,
      closeReview: () => Promise.reject(new Error('git')),
    });
    await start();

    conveyor.onChainEnded(LINK, { status: 'done', result: { kind: 'reviewed' } });
    await vi.waitFor(() => expect(logs).toContain('split conveyor: review close failed'));

    expect(view()).toMatchObject({ status: 'done' });
    expect(view()?.reviewClose).toBeUndefined();
  });
});
