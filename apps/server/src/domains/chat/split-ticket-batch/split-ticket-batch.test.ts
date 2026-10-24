import { describe, expect, it } from 'vitest';
import {
  bundleSplitTickets,
  clusterSplitTickets,
  openSplitTickets,
  type OpenSplitTicket,
} from '@agentdeck/contracts/split-ticket-batch';
import { splitTicketKey, type SplitTicketView } from '@agentdeck/contracts/split-tickets';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { issueDescription, takePrompt } from './compose.ts';
import { draftsFromReply, prepareTickets } from './prepare.ts';
import { priorityFor } from './priority.ts';
import { publishTickets, type BatchIssueInput, type BatchTracker } from './publish.ts';
import { SplitTicketMarks } from './ticket-marks.ts';

/**
 * «Разобрать…» по частям, без сети и процессов: склейка повторов, ответ модели
 * как данные, приоритет по имени, замки заведения и частичный отказ. Путь
 * целиком (маршрут → конвейер → клиент Jira) — в интеграционной проверке маршрутов.
 */

const at = '2026-10-24T10:00:00.000Z';
const t = (title: string, where: string, why = 'why'): SplitTicketView => ({
  title,
  where,
  why,
  at,
});

const open = (...tickets: [string, string][]): OpenSplitTicket[] =>
  tickets.map(([title, where]) => ({
    key: splitTicketKey({ title, where }),
    title,
    where,
    why: 'why',
    groups: ['G'],
  }));

function record(groups: SplitTicketView[][]): SplitPlanRecord {
  return {
    parentChatId: 'p',
    projectPath: '/work/app',
    createdAt: at,
    order: groups.map((_, index) => index),
    request: {},
    proposal: { groups: [] },
    groups: groups.map((tickets, index) => ({
      index,
      title: `Группа ${index + 1}`,
      branch: `b${index}`,
      after: [],
      status: 'done',
      tickets,
    })),
  } as SplitPlanRecord;
}

function memoryStore(initial: SplitPlanRecord) {
  let current = structuredClone(initial);
  return {
    get: () => structuredClone(current),
    set: (next: SplitPlanRecord) => {
      current = structuredClone(next);
    },
    peek: () => current,
  };
}

describe('openSplitTickets + clusterSplitTickets (deterministic pre-pass)', () => {
  it('filed or taken in any group is not open; same key across groups is one row', () => {
    const rec = record([
      [t('A', 'a.ts:1'), { ...t('B', 'b.ts:2'), filed: { key: 'PROJ-1', at } }],
      [t('A', 'a.ts:1'), t('B', 'b.ts:2'), { ...t('C', 'c.ts:3'), taken: { chatId: 'x', at } }],
    ]);
    const rows = openSplitTickets(rec.groups);
    expect(rows.map((row) => row.title)).toEqual(['A']);
    expect(rows[0]?.groups).toEqual(['Группа 1', 'Группа 2']);
  });

  it('identical normalised title or specific where merge; short where never merges', () => {
    const clusters = clusterSplitTickets(
      open(
        ['Go tests fail on Windows.', 'server/go_test.go:12'],
        ['go  tests FAIL on windows', 'elsewhere/x.go:1'],
        ['Different words', 'server/go_test.go:12'],
        ['Help links factory', 'web'],
        ['Unrelated', 'web'],
      ),
    );
    expect(clusters.map((cluster) => cluster.tickets.map((ticket) => ticket.title))).toEqual([
      ['Go tests fail on Windows.', 'go  tests FAIL on windows', 'Different words'],
      ['Help links factory'],
      ['Unrelated'],
    ]);
    expect(clusters.map((cluster) => cluster.id)).toEqual(['C1', 'C2', 'C3']);
  });
});

describe('model output is data (draftsFromReply)', () => {
  const clusters = bundleSplitTickets(
    clusterSplitTickets(open(['A', 'a.ts:1'], ['B', 'b.ts:2'], ['C', 'c.ts:3'])),
  );

  it('unknown fields dropped, invented and reused ids dropped, forgotten cluster gets its own issue', () => {
    const reply = [
      'Sure! ```json',
      JSON.stringify({
        issues: [
          {
            title: 'A and B',
            description: 'merged',
            area: ['backend', 'marketing', 'BACKEND'],
            severity: 'HIGH',
            sources: ['C1', 'c2', 'C99'],
            assignee: 'someone',
          },
          { title: 'Steals C1', sources: ['C1'] },
          { title: '', sources: ['C3'] },
        ],
        extra: true,
      }),
      '```',
    ].join('\n');
    const drafts = draftsFromReply(reply, clusters, 'en');
    expect(drafts).toHaveLength(2);
    expect(drafts?.[0]).toMatchObject({ title: 'A and B', area: ['backend'], severity: 'high' });
    expect(drafts?.[0]?.clusters.map((cluster) => cluster.id)).toEqual(['C1', 'C2']);
    expect(drafts?.[0]).not.toHaveProperty('assignee');
    // C3 — модель описала его без названия: своей задачей без модели, область пуста.
    expect(drafts?.[1]).toMatchObject({ title: 'C', area: [] });
    expect(drafts?.[1]?.severity).toBeUndefined();
  });

  it('not JSON, wrong shape or no valid issue → undefined (caller falls back)', () => {
    expect(draftsFromReply('no json here', clusters, 'en')).toBeUndefined();
    expect(draftsFromReply('{"issues": "x"}', clusters, 'en')).toBeUndefined();
    expect(draftsFromReply('{"issues":[{"title":"x","sources":["C7"]}]}', clusters, 'en')).toBe(
      undefined,
    );
  });

  it('model throws → fallback: one issue per cluster, area/severity empty', async () => {
    const prepared = await prepareTickets(
      clusters,
      async () => {
        throw new Error('model down');
      },
      'ru',
    );
    expect(prepared.mode).toBe('fallback');
    expect(prepared.drafts.map((draft) => draft.title)).toEqual(['A', 'B', 'C']);
    expect(prepared.drafts.every((draft) => draft.area.length === 0 && !draft.severity)).toBe(true);
    expect(issueDescription(prepared.drafts[0]!, 'ru')).toContain('1. A\nГде: a.ts:1');
  });

  it('the prompt carries clusters as data with secrets masked', async () => {
    let seen = '';
    const secret = open(['Leak', 'x.ts:1']).map((row) => ({
      ...row,
      why: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in log',
    }));
    await prepareTickets(
      bundleSplitTickets(clusterSplitTickets(secret)),
      async (prompt) => {
        seen = prompt;
        return '{}';
      },
      'en',
    );
    expect(seen).toContain('"id":"C1"');
    expect(seen).toContain('write title, summary and problems in English');
    expect(seen).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('priorityFor (severity → Jira priority by name)', () => {
  it('maps by the instance names, case-insensitive; none → undefined', () => {
    expect(priorityFor('critical', ['Highest', 'High', 'Medium', 'Low'])).toBe('Highest');
    expect(priorityFor('high', ['Blocker', 'Major', 'Minor'])).toBe('Major');
    expect(priorityFor('medium', ['Высокий', 'Средний', 'Низкий'])).toBe('Средний');
    expect(priorityFor('low', ['P1', 'P2'])).toBeUndefined();
  });

  it('unmapped severity → footer line (and the publish adds a severity-<x> label)', () => {
    const issue = {
      summary: '',
      clusters: clusterSplitTickets(open(['A', 'a.ts:1'])),
      details: new Map(),
    };
    const text = issueDescription(issue, 'en', 'low');
    expect(text).toContain('Severity: low (Jira has no priority with this name)');
    expect(text).toContain('1. A\nWhere: a.ts:1\nEvidence: why\nFound by groups: G');
  });
});

describe('SplitTicketMarks + publishTickets', () => {
  function tracker(fail: (input: BatchIssueInput) => boolean = () => false) {
    const created: BatchIssueInput[] = [];
    let next = 1;
    const api: BatchTracker = {
      priorities: async () => ['Highest', 'High', 'Medium', 'Low'],
      create: async (input) => {
        await new Promise((done) => setTimeout(done, 5));
        if (fail(input)) throw Object.assign(new Error('Jira 500'), { messageCode: 'nope' });
        created.push(input);
        return `PROJ-${next++}`;
      },
      searchOpen: async () => [],
      comment: async () => {
        throw new Error('no open issue to comment on in these tests');
      },
      issueUrl: (key) => `https://tracker.example.com/browse/${key}`,
    };
    return { api, created };
  }

  const twoDefects = () =>
    record([
      [t('A', 'a.ts:1'), t('B', 'b.ts:2')],
      [t('A', 'a.ts:1'), t('a', 'other.ts:9')],
    ]);

  it('double click: two concurrent publishes create each issue once; marks on every group', async () => {
    const store = memoryStore(twoDefects());
    const marks = new SplitTicketMarks(store);
    const { api, created } = tracker();
    const input = { parentChatId: 'p', projectKey: 'PROJ', issueType: 'Bug', lang: 'en' as const };
    const deps = { marks, record: () => store.get(), tracker: api };

    const [first, second] = await Promise.allSettled([
      publishTickets(deps, input),
      publishTickets(deps, input),
    ]);

    expect(created.map((issue) => issue.summary)).toEqual(['A', 'B']);
    expect(first.status === 'fulfilled' && first.value.issues.map((issue) => issue.key)).toEqual([
      'PROJ-1',
      'PROJ-2',
    ]);
    // Вторая публикация ждала первую и увидела: открытых больше нет.
    expect(second.status).toBe('rejected');
    expect(second.status === 'rejected' && second.reason.messageCode).toBe(
      'split-ticket-batch-empty',
    );
    const filed = store.peek().groups.map((group) => group.tickets?.map((x) => x.filed?.key));
    expect(filed).toEqual([
      ['PROJ-1', 'PROJ-2'],
      ['PROJ-1', 'PROJ-1'],
    ]);
    expect(created[0]?.labels).toEqual(['agentdeck-proposal']);
  });

  it('single «File» racing the batch on the same proposal: one issue, the batch reuses its key', async () => {
    const store = memoryStore(record([[t('A', 'a.ts:1')]]));
    const marks = new SplitTicketMarks(store);
    const { api, created } = tracker();
    const key = splitTicketKey({ title: 'A', where: 'a.ts:1' });
    const single = marks.fileKeys('p', [key], () =>
      api.create({
        projectKey: 'PROJ',
        summary: 'single',
        description: '',
        issueType: 'Bug',
        labels: [],
      }),
    );
    const batch = publishTickets(
      { marks, record: () => store.get(), tracker: api },
      { parentChatId: 'p', projectKey: 'PROJ', issueType: 'Bug', lang: 'en' },
    );
    const [one, many] = await Promise.all([single, batch]);
    expect(created).toHaveLength(1);
    expect(one).toMatchObject({ key: 'PROJ-1', created: true });
    expect(many.issues).toEqual([expect.objectContaining({ key: 'PROJ-1', created: false })]);
  });

  it('partial failure: created stay filed, failed listed with reason; retry files only the failed', async () => {
    const store = memoryStore(twoDefects());
    const marks = new SplitTicketMarks(store);
    let broken = true;
    const { api, created } = tracker((input) => broken && input.summary === 'B issue');
    let asked = 0;
    const ask = async (): Promise<string> => {
      asked += 1;
      return JSON.stringify({
        issues: [
          { title: 'A issue', area: ['frontend'], severity: 'critical', sources: ['C1'] },
          { title: 'B issue', severity: 'low', sources: ['C2'] },
        ],
      });
    };
    const deps = { marks, record: () => store.get(), tracker: api, ask };
    const input = { parentChatId: 'p', projectKey: 'PROJ', issueType: 'Task', lang: 'en' as const };

    const firstRun = await publishTickets(deps, input);
    expect(firstRun.mode).toBe('model');
    expect(firstRun.issues.map((issue) => issue.title)).toEqual(['A issue']);
    // Незнакомый код ошибки ('nope') клиенту не уходит — только текст.
    expect(firstRun.failed).toEqual([
      { title: 'B issue', message: 'Jira 500', proposals: ['b|b.ts:2'] },
    ]);
    expect(created[0]).toMatchObject({
      priority: 'Highest',
      labels: ['frontend', 'agentdeck-proposal'],
      issueType: 'Task',
    });

    broken = false;
    const retry = await publishTickets(deps, { ...input, retryFailed: true });
    expect(asked).toBe(1);
    expect(retry.issues.map((issue) => issue.title)).toEqual(['B issue']);
    expect(retry.failed).toEqual([]);
    expect(created.map((issue) => issue.summary)).toEqual(['A issue', 'B issue']);
    expect(created[1]).toMatchObject({ priority: 'Low', labels: ['agentdeck-proposal'] });
  });

  it('a key not in the record is refused before any tracker call', async () => {
    const store = memoryStore(twoDefects());
    const marks = new SplitTicketMarks(store);
    const { api, created } = tracker();
    await expect(
      marks.fileKeys('p', ['invented|key'], () =>
        api.create({
          projectKey: 'P',
          summary: 's',
          description: '',
          issueType: 'Bug',
          labels: [],
        }),
      ),
    ).rejects.toMatchObject({ messageCode: 'split-ticket-missing' });
    expect(created).toEqual([]);
  });

  it('markTaken marks every group carrying the proposal, skips filed ones', () => {
    const store = memoryStore(
      record([
        [t('A', 'a.ts:1'), { ...t('B', 'b.ts:2'), filed: { key: 'PROJ-1', at } }],
        [t('A', 'a.ts:1')],
      ]),
    );
    const marks = new SplitTicketMarks(store);
    const keys = [
      splitTicketKey({ title: 'A', where: 'a.ts:1' }),
      splitTicketKey({ title: 'B', where: 'b.ts:2' }),
    ];
    expect(marks.markTaken('p', keys, 'chat-9')).toBe(1);
    const taken = store.peek().groups.map((group) => group.tickets?.map((x) => x.taken?.chatId));
    expect(taken).toEqual([['chat-9', undefined], ['chat-9']]);
  });

  it('take prompt lists merged duplicates once with «same defect in other words»', () => {
    const prompt = takePrompt(
      bundleSplitTickets(
        clusterSplitTickets(open(['A', 'a.ts:1'], ['a', 'other.ts:2'], ['B', 'b.ts:3'])),
      ),
      'en',
    );
    expect(prompt).toContain('Task 1\n1. A\nWhere: a.ts:1');
    expect(prompt).toContain('Same defect in other words: «a» (other.ts:2)');
    expect(prompt).toContain('Task 2\n1. B');
  });
});
