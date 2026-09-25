import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { serverText } from '../../lib/server-texts.ts';
import type { ChatEvent } from './ChatRunner.ts';
import {
  SplitConveyor,
  stageTraceGaps,
  type SplitConveyorDeps,
  type SplitDeliveryDeps,
} from './split-conveyor.ts';

/**
 * Готовность группы по следам звеньев (аудит 25.09, L110): факты git видели
 * пуш и MR, но не видели, что ревью дошло до вердикта, а вердикт с
 * замечаниями — до правок. Конвейер настоящий; снаружи — запуск копий, факты
 * доставки (их ответ задаёт тест) и часы.
 */

const PARENT = 'родитель';
const MR = 'https://tracker.example.com/app/-/merge_requests/7';
const PROPOSAL = {
  groups: [
    { title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 первая'] },
    { title: 'Два', branch: 'feature/two', tasks: ['PROJ-2 вторая'] },
  ],
};

function build(facts: Awaited<ReturnType<SplitDeliveryDeps['facts']>>) {
  const records = new Map<string, SplitPlanRecord>();
  const notices: ChatEvent[] = [];
  const nudges: string[] = [];
  const scheduled: (() => void)[] = [];
  const delivery: SplitDeliveryDeps = {
    facts: async () => facts,
    nudge: (_group, prompt) => {
      nudges.push(prompt);
      return 'sent';
    },
    schedule: (run) => void scheduled.push(run),
  };
  const deps: SplitConveyorDeps = {
    store: {
      get: (parent) => {
        const record = records.get(parent);
        return record ? structuredClone(record) : undefined;
      },
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) => {
        const record = [...records.values()].find((item) => ids.includes(item.triageChatId ?? ''));
        return record ? structuredClone(record) : undefined;
      },
      all: () =>
        Object.fromEntries([...records].map(([key, value]) => [key, structuredClone(value)])),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: record.proposal.groups[index]?.title ?? '',
        branch: record.groups[index]?.branch ?? '',
        chatId: `chat-${index}`,
        path: `C:/copies/${index}`,
        isWorktree: true,
        started: true,
        prompt: '',
        deliver: true,
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    parallel: () => 2,
    delivery,
    notify: (_parent, event) => void notices.push(event),
    log: () => undefined,
  };
  const conveyor = new SplitConveyor(deps);
  const link = (index: number, stage: ChatLink['stage']): ChatLink => ({
    parentChatId: PARENT,
    createdAt: '',
    branch: PROPOSAL.groups[index]?.branch ?? '',
    groupIndex: index,
    stage,
  });
  const flush = () => new Promise((done) => setTimeout(done, 5));
  /** Доводит проверки доставки: первая сверка откладывается на секунды у форджа. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      await flush();
      const next = scheduled.shift();
      if (next) next();
    }
  };
  const begin = async (): Promise<void> => {
    await conveyor.begin({
      parentChatId: PARENT,
      projectPath: 'C:/repo',
      proposal: PROPOSAL,
      request: {},
    });
    conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
    await flush();
  };
  const group = (index: number) => records.get(PARENT)?.groups[index];
  return { conveyor, link, begin, settle, group, notices, nudges };
}

describe('SplitConveyor: готовность по следам звеньев', () => {
  it('ревью с замечаниями кончило цепочку без правок — не готово, группе напоминание', async () => {
    const t = build({ missing: [], mr: MR });
    await t.begin();
    t.conveyor.onChainResumed(t.link(0, 'work'));
    t.conveyor.onChainResumed(t.link(0, 'review'));
    t.conveyor.onChainEnded(t.link(0, 'review'), { status: 'done', reviewFindings: 2 });
    await t.settle();

    const fixMissing = serverText('delivery-gap-fix-missing', { count: 2 });
    expect(t.group(0)?.status).not.toBe('done');
    expect(t.group(0)?.deliveryMissing).toEqual([fixMissing]);
    expect(t.nudges.join('\n')).toContain(fixMissing);
  });

  it('ревью → правки → доставка: следы полны, группа готова', async () => {
    const t = build({ missing: [], mr: MR });
    await t.begin();
    for (const stage of ['work', 'review', 'fix', 'deliver'] as const) {
      t.conveyor.onChainResumed(t.link(0, stage));
    }
    t.conveyor.onChainEnded(t.link(0, 'deliver'), { status: 'done' });
    await t.settle();
    expect(t.group(0)?.status).toBe('done');
    expect(t.group(0)?.stageTrace?.map((entry) => entry.stage)).toEqual([
      'work',
      'review',
      'fix',
      'deliver',
    ]);
  });

  it('описание MR не прочитано — группа готова, родителю заметка', async () => {
    const t = build({ missing: [], mr: MR, descriptionUnchecked: true });
    await t.begin();
    t.conveyor.onChainEnded(t.link(0, 'work'), { status: 'done' });
    await t.settle();
    expect(t.group(0)?.status).toBe('done');
    expect(t.notices).toContainEqual(
      expect.objectContaining({
        code: 'deliveryUnchecked',
        textCode: 'split-delivery-description-unchecked-notice',
        textParams: { group: 'Раз', mr: MR },
      }),
    );
  });
});

describe('stageTraceGaps', () => {
  it('без ревью следам проверять нечего; ревью без вердикта и без правок — пробелы', () => {
    expect(stageTraceGaps(undefined)).toEqual([]);
    expect(stageTraceGaps([{ stage: 'work', at: '' }])).toEqual([]);
    expect(stageTraceGaps([{ stage: 'review', at: '' }])).toEqual([
      serverText('delivery-gap-review-unfinished'),
    ]);
    expect(stageTraceGaps([{ stage: 'review', at: '', findings: 0 }])).toEqual([]);
    expect(stageTraceGaps([{ stage: 'review', at: '', findings: 3 }])).toEqual([
      serverText('delivery-gap-fix-missing', { count: 3 }),
    ]);
    expect(
      stageTraceGaps([
        { stage: 'review', at: '', findings: 3 },
        { stage: 'fix', at: '' },
      ]),
    ).toEqual([]);
  });
});
