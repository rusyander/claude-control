import { describe, it, expect } from 'vitest';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import type { MrStates } from '../../integrations/mr-state/mr-state.ts';
import { MR_STATE_TTL_MS, MrStateRefresh } from './mr-state-refresh.ts';

/**
 * «Влит ли MR» пока хаб открыт: когда фордж спрашивается, о чём и что после
 * этого лежит в записи. Фордж подменён ответом `read`; хранилище — карта
 * записей, как у настоящего `setSplitPlan`.
 */

const MR = (n: number) => `https://git.acme.local/team/app/-/merge_requests/${n}`;

function group(index: number, extra: Partial<SplitPlanGroupRecord> = {}): SplitPlanGroupRecord {
  return { index, status: 'done', mr: MR(900 + index), ...extra } as SplitPlanGroupRecord;
}

function setup(groups: SplitPlanGroupRecord[], answer: Record<string, string> = {}) {
  const records = new Map<string, SplitPlanRecord>([
    ['p', { parentChatId: 'p', groups } as unknown as SplitPlanRecord],
  ]);
  const asked: string[][] = [];
  const writes: SplitPlanRecord[] = [];
  let clock = 1_000_000;
  let reply: MrStates | undefined = {
    states: new Map(Object.entries(answer) as [string, 'open' | 'merged' | 'closed'][]),
    failed: [],
  };
  const refresh = new MrStateRefresh({
    store: {
      get: (id) => structuredClone(records.get(id)),
      set: (record) => {
        writes.push(record);
        records.set(record.parentChatId, structuredClone(record));
      },
    },
    read: (urls) => {
      asked.push(urls);
      return Promise.resolve(reply);
    },
    now: () => clock,
    log: () => undefined,
  });
  return {
    refresh,
    asked,
    writes,
    record: () => records.get('p'),
    tick: (ms: number) => {
      clock += ms;
    },
    noToken: () => {
      reply = undefined;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MrStateRefresh', () => {
  it('влитый и закрытый записываются в группы, открытый не трогается', async () => {
    const s = setup([group(0), group(1), group(2)], {
      [MR(900)]: 'merged',
      [MR(901)]: 'open',
      [MR(902)]: 'closed',
    });
    await s.refresh.refresh('p');

    expect(s.asked).toEqual([[MR(900), MR(901), MR(902)]]);
    expect(s.record()?.groups.map((g) => g.mrClosed)).toEqual(['merged', undefined, 'closed']);
    expect(s.writes).toHaveLength(1);
  });

  it('влитый больше не спрашивается; закрытый — спрашивается и, открытый снова, теряет отметку', async () => {
    const s = setup(
      [group(0, { mrClosed: 'merged' }), group(1, { mrClosed: 'closed' }), group(2)],
      { [MR(901)]: 'open', [MR(902)]: 'open' },
    );
    await s.refresh.refresh('p');

    expect(s.asked).toEqual([[MR(901), MR(902)]]);
    expect(s.record()?.groups.map((g) => g.mrClosed)).toEqual(['merged', undefined, undefined]);
  });

  it('спрашивать не о чем — запроса нет вовсе; ничего не изменилось — записи нет', async () => {
    const none = setup([group(0, { mr: undefined }), group(1, { mrClosed: 'merged' })]);
    await none.refresh.refresh('p');
    expect(none.asked).toEqual([]);

    const same = setup([group(0)], { [MR(900)]: 'open' });
    await same.refresh.refresh('p');
    expect(same.asked).toHaveLength(1);
    expect(same.writes).toHaveLength(0);
  });

  it('touch: не чаще раза в MR_STATE_TTL_MS на план, после срока — снова', async () => {
    const s = setup([group(0)], { [MR(900)]: 'open' });
    s.refresh.touch('p');
    await settle();
    s.refresh.touch('p');
    s.tick(MR_STATE_TTL_MS - 1);
    s.refresh.touch('p');
    await settle();
    expect(s.asked).toHaveLength(1);

    s.tick(1);
    s.refresh.touch('p');
    await settle();
    expect(s.asked).toHaveLength(2);
  });

  it('пока идёт проверка, второй touch не шлёт второй запрос', async () => {
    const s = setup([group(0)], { [MR(900)]: 'merged' });
    s.refresh.touch('p');
    s.tick(MR_STATE_TTL_MS * 2);
    s.refresh.touch('p');
    await settle();
    expect(s.asked).toHaveLength(1);
    expect(s.record()?.groups[0]?.mrClosed).toBe('merged');
  });

  it('читать нечем (нет токена) — запись не меняется, и срок не тратится', async () => {
    const s = setup([group(0)]);
    s.noToken();
    s.refresh.touch('p');
    await settle();
    expect(s.writes).toHaveLength(0);
    // Токен появился — следующий взгляд спрашивает сразу, без пяти минут ожидания.
    s.refresh.touch('p');
    await settle();
    expect(s.asked).toHaveLength(2);
  });
});
