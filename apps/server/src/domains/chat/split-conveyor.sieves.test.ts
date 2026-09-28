import { describe, expect, it } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { LearnedSieveRow, SieveClass } from '@agentdeck/contracts/sieves';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { localizeText, serverText } from '../../lib/server-texts.ts';
import { chainOutcomeOf } from './chain-outcome.ts';
import { SplitConveyor, type SplitConveyorDeps, type SplitDeliveryDeps } from './split-conveyor.ts';

/**
 * Сита в конвейере разделения (решение владельца 28.09): отчёт звеньев едет в
 * запись группы, сито из треда MR уходит в хранилище вместе со ссылками,
 * которые наблюдатель сам переслал, а пойманный до MR блокер считается раз на
 * группу, сколько бы напоминаний ни понадобилось. Конвейер настоящий, итог
 * хода собирается настоящим `chainOutcomeOf` из текста с блоком.
 */

const PARENT = 'родитель';
const MR = 'https://tracker.example.com/app/-/merge_requests/7';
const PROPOSAL = { groups: [{ title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 первая'] }] };
const LANG = 'agentdeck:sieves';

function build(verdicts: Awaited<ReturnType<SplitDeliveryDeps['facts']>>[]) {
  const records = new Map<string, SplitPlanRecord>();
  const nudges: string[] = [];
  const scheduled: (() => void)[] = [];
  const learned: {
    rows: readonly LearnedSieveRow[];
    relayed: readonly string[];
    projectPath: string;
    mr?: string;
  }[] = [];
  const caught: SieveClass[][] = [];
  let call = 0;
  const delivery: SplitDeliveryDeps = {
    facts: async () => verdicts[Math.min(call++, verdicts.length - 1)] ?? { missing: [] },
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
    sieves: {
      learn: (input) => {
        learned.push(input);
        return { accepted: input.rows.slice(0, 1), rejected: input.rows.slice(1) };
      },
      caught: (classes) => void caught.push([...classes]),
    },
    notify: () => undefined,
    log: () => undefined,
  };
  const conveyor = new SplitConveyor(deps);
  const link = (stage: ChatLink['stage'], extra: Partial<ChatLink> = {}): ChatLink => ({
    parentChatId: PARENT,
    createdAt: '',
    branch: 'feature/one',
    groupIndex: 0,
    stage,
    ...extra,
  });
  const flush = () => new Promise((done) => setTimeout(done, 5));
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
  const group = () => records.get(PARENT)?.groups[0];
  const patch = (fn: (record: SplitPlanRecord) => void): void => {
    const record = records.get(PARENT);
    if (!record) return;
    fn(record);
    records.set(PARENT, record);
  };
  return { conveyor, link, begin, settle, group, patch, nudges, learned, caught };
}

const outcomeOf = (link: ChatLink, text: string) => chainOutcomeOf({ link, ok: true, text });

describe('SplitConveyor: сита перед MR', () => {
  it('отчёт звеньев складывается в запись группы: ревью по связи, доставка из текста', async () => {
    const t = build([{ missing: [], mr: MR }]);
    await t.begin();
    const deliver = t.link('deliver', {
      sieveRows: [
        { id: 'contract-by-request', status: 'pass', evidence: 'curl /api/x → 404 as documented' },
      ],
    });
    t.conveyor.onChainResumed(deliver);
    const text = `Готово.\n\n\`\`\`${LANG}\n{"sieves":[{"id":"browser-focus","status":"pass","evidence":"npx playwright test focus → 3 passed"}]}\n\`\`\`\n\n${MR}`;
    t.conveyor.onChainEnded(deliver, outcomeOf(deliver, text));
    await t.settle();
    expect(t.group()?.sieveRows?.map((row) => row.id)).toEqual([
      'contract-by-request',
      'browser-focus',
    ]);
    expect(t.group()?.status).toBe('done');
  });

  it('сито из треда MR уходит на приём со ссылками, которые переслал наблюдатель', async () => {
    const t = build([{ missing: [], mr: MR }]);
    await t.begin();
    t.patch((record) => {
      const group = record.groups[0];
      if (!group) return;
      group.mr = MR;
      group.mrWatch = { cycle: 'c', checks: 1, relayedLinks: [`${MR}#note_5`] };
    });
    const deliver = t.link('deliver');
    t.conveyor.onChainResumed(deliver);
    const text =
      `Поправил.\n\`\`\`${LANG}\n{"learned":[{"thread":"${MR}#note_5","class":"contract","scope":"global",` +
      `"trigger":"status code of a handler changes","check":"curl the endpoint on the branch stand and compare with docs"}]}\n\`\`\``;
    t.conveyor.onChainEnded(deliver, outcomeOf(deliver, text));
    expect(t.learned).toHaveLength(1);
    expect(t.learned[0]).toMatchObject({
      relayed: [`${MR}#note_5`],
      projectPath: 'C:/repo',
      mr: MR,
      rows: [{ thread: `${MR}#note_5`, class: 'contract', scope: 'global' }],
    });
  });

  it('пойманный до MR блокер считается раз на группу и класс, напоминание несёт пробел сита', async () => {
    const gap = serverText('sieve-gap-conflicts', { files: 'src/a.ts' });
    const t = build([
      { missing: [gap], mr: MR, sieveClasses: ['integration'] },
      { missing: [gap], mr: MR, sieveClasses: ['integration'] },
      { missing: [], mr: MR },
    ]);
    await t.begin();
    const deliver = t.link('deliver');
    t.conveyor.onChainResumed(deliver);
    t.conveyor.onChainEnded(deliver, { status: 'done' });
    await t.settle();
    expect(t.caught).toEqual([['integration']]);
    expect(t.group()?.sieveCaught).toEqual(['integration']);
    expect(t.nudges).toHaveLength(1);
    // Задание группе — по-английски: строка пробела сита переведена, не русская.
    expect(localizeText(gap, 'en')).not.toBe(gap);
    expect(t.nudges[0]).toContain(localizeText(gap, 'en'));
  });
});
