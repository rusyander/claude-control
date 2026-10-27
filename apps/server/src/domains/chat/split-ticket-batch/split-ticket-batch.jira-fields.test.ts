import { describe, expect, it } from 'vitest';
import {
  clusterSplitTickets,
  ticketSide,
  type OpenSplitTicket,
} from '@agentdeck/contracts/split-ticket-batch';
import { splitTicketKey, type SplitTicketView } from '@agentdeck/contracts/split-tickets';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { FINGERPRINT_PREFIX, fingerprintOf } from './compose.ts';
import { decisionsByCluster, findDuplicates, type DuplicateTracker } from './duplicates.ts';
import type { OpenTrackerIssue } from './existing.ts';
import { priorityRejected } from './priority.ts';
import { publishTickets, type BatchIssueInput, type BatchTracker } from './publish.ts';
import type { TicketPrints } from './prints.ts';
import { SplitTicketMarks } from './ticket-marks.ts';

/**
 * Требования владельца 25.10.2026 к задачам, которые публикация заводит в Jira:
 * сторона (фронт/бэк) меткой и строкой, приоритет у каждой задачи и имя, которое
 * Jira примет, никакого исполнителя, полное описание без машинных меток, повторы
 * в Jira — человеку на решение. Без сети и модели: трекер — запись вызовов.
 */

const at = '2026-10-25T10:00:00.000Z';
const view = (title: string, where: string, why = 'why'): SplitTicketView => ({
  title,
  where,
  why,
  at,
});
const row = (title: string, where: string): OpenSplitTicket => ({
  key: splitTicketKey({ title, where }),
  title,
  where,
  why: 'why',
  groups: ['G'],
});

function memory(groups: SplitTicketView[][]) {
  let current = {
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
  return {
    get: () => structuredClone(current),
    set: (next: SplitPlanRecord) => {
      current = structuredClone(next);
    },
    peek: () => current,
  };
}

interface Options {
  open?: OpenTrackerIssue[];
  similar?: OpenTrackerIssue[];
  priorities?: string[];
  /** Отказ заведения: вернуть ошибку — бросить её. */
  reject?: (input: BatchIssueInput) => unknown;
  assignee?: string;
}

function fakeTracker(options: Options = {}) {
  const created: BatchIssueInput[] = [];
  const attempts: BatchIssueInput[] = [];
  const comments: { key: string; body: string }[] = [];
  const similarQueries: { words: string[]; prints: string[]; keys: string[] }[] = [];
  const api: BatchTracker & DuplicateTracker = {
    priorities: async () => options.priorities ?? ['Highest', 'High', 'Medium', 'Low'],
    searchOpen: async () => options.open ?? [],
    searchSimilar: async (_project, query) => {
      similarQueries.push(query);
      return options.similar ?? [];
    },
    create: async (input) => {
      attempts.push(input);
      const error = options.reject?.(input);
      if (error) throw error;
      created.push(input);
      return {
        key: `PROJ-${created.length}`,
        ...(options.assignee ? { assignee: options.assignee } : {}),
      };
    },
    comment: async (key, body) => {
      comments.push({ key, body });
    },
    issueUrl: (key) => `https://tracker.example.com/browse/${key}`,
  };
  return { api, created, attempts, comments, similarQueries };
}

const input = { parentChatId: 'p', projectKey: 'PROJ', issueType: 'Bug', lang: 'ru' as const };

describe('ticketSide — frontend or backend, from the paths and the model area', () => {
  it.each([
    { wheres: ['apps/web/src/export.ts:42'], area: [], side: 'frontend' },
    { wheres: ['src/ui/Button.tsx'], area: [], side: 'frontend' },
    { wheres: ['cp-admin-ui/src/pages/list.ts'], area: [], side: 'frontend' },
    { wheres: ['apps/server/src/routes/a.ts:7'], area: [], side: 'backend' },
    { wheres: ['internal/billing/charge.go:12'], area: [], side: 'backend' },
    { wheres: ['db/migrations/0042_add.sql'], area: [], side: 'backend' },
    { wheres: ['apps/web/a.tsx', 'apps/server/b.ts'], area: [], side: 'fullstack' },
    { wheres: ['apps/web/a.tsx'], area: ['backend'], side: 'fullstack' },
    { wheres: ['экран настроек'], area: ['backend'], side: 'backend' },
    { wheres: ['экран настроек'], area: [], side: 'other' },
    { wheres: ['src/api/client.ts'], area: [], side: 'other' },
    { wheres: ['.github/workflows/ci.yml'], area: ['infra'], side: 'other' },
  ])('$wheres + $area → $side', ({ wheres, area, side }) => {
    expect(ticketSide(wheres, area)).toBe(side);
  });
});

describe('publishTickets — what each new Jira issue carries', () => {
  it('fallback (no model): side label + «Сторона» line, priority Medium, full description, no assignee', async () => {
    const store = memory([
      [view('Падает экспорт отчёта', 'apps/web/src/export.ts:42', 'пустой файл')],
      [view('Сервер отвечает 500 на /api/report', 'apps/server/src/report.ts:9')],
    ]);
    const { api, created } = fakeTracker();
    const result = await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api },
      input,
    );

    expect(result.mode).toBe('fallback');
    // Только словесные метки: хэш-метки разделения в Jira нет (владелец 26.10.2026).
    expect(created.map((issue) => issue.labels)).toEqual([
      ['frontend', 'agentdeck-proposal'],
      ['backend', 'agentdeck-proposal'],
    ]);
    expect(created.map((issue) => issue.priority)).toEqual(['Medium', 'Medium']);
    for (const issue of created) expect(Object.keys(issue)).not.toContain('assignee');
    const [front] = created;
    const blocks = front?.description.split('\n\n') ?? [];
    expect(blocks[0]).toBe(
      'Сторона: FRONTEND — фронтенд\nСерьёзность: medium → приоритет Jira «Medium»',
    );
    expect(blocks.slice(1, 5)).toEqual([
      'Контекст: Группы разделения нашли это вне своих задач: Группа 1.',
      'Что сделать: Устранить дефект «Падает экспорт отчёта»; место и доказательства — ниже.',
      'Критерии приёмки:\n- «Падает экспорт отчёта» больше не воспроизводится',
      'Где в коде:\n- apps/web/src/export.ts:42',
    ]);
    expect(blocks[5]).toContain(
      'Дефекты:\n1. Падает экспорт отчёта\nГде: apps/web/src/export.ts:42',
    );
    expect(blocks[5]).toContain('Доказательства: пустой файл');
    expect(blocks.some((block) => block.includes('labels ='))).toBe(false);
    // Отпечаток находки в текст не уходит (владелец 26.10.2026) — он в памяти панели.
    expect(front?.description).not.toContain(FINGERPRINT_PREFIX);
    expect(front?.description).not.toContain(
      fingerprintOf(
        splitTicketKey({ title: 'Падает экспорт отчёта', where: 'apps/web/src/export.ts:42' }),
      ),
    );
    expect(result.issues.map((issue) => [issue.side, issue.priority])).toEqual([
      ['frontend', 'Medium'],
      ['backend', 'Medium'],
    ]);
  });

  it('model fix and acceptance land in their sections; severity maps to the instance name', async () => {
    const store = memory([[view('Падает экспорт отчёта', 'apps/web/src/export.ts:42')]]);
    const { api, created } = fakeTracker({ priorities: ['Blocker', 'Major', 'Minor'] });
    const ask = async (): Promise<string> =>
      JSON.stringify({
        issues: [
          {
            title: 'Экспорт отчёта падает на пустом списке',
            summary: 'Отчёт нельзя выгрузить.',
            fix: 'Вернуть файл с заголовком при пустом списке.',
            acceptance: ['Пустой список выгружается файлом с заголовком', 7, ''],
            area: ['backend'],
            severity: 'high',
            sources: ['B1'],
          },
        ],
      });
    await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api, ask },
      input,
    );
    const issue = created[0];
    expect(issue?.priority).toBe('Major');
    // Путь фронта и область модели «backend» — работа на обеих сторонах.
    expect(issue?.labels.slice(0, 3)).toEqual(['frontend', 'backend', 'fullstack']);
    const blocks = issue?.description.split('\n\n') ?? [];
    expect(blocks[0]).toBe(
      'Сторона: FULLSTACK — фронтенд и бэкенд\nСерьёзность: high → приоритет Jira «Major»',
    );
    expect(blocks[1]).toBe('Контекст: Отчёт нельзя выгрузить.');
    expect(blocks[2]).toBe('Что сделать: Вернуть файл с заголовком при пустом списке.');
    expect(blocks[3]).toBe('Критерии приёмки:\n- Пустой список выгружается файлом с заголовком');
  });

  it('no instance name for the severity → no priority, severity label + line (Jira never gets an invented name)', async () => {
    const store = memory([[view('A defect', 'a.ts:1')]]);
    const { api, created } = fakeTracker({ priorities: ['P1', 'P2'] });
    await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api },
      input,
    );
    expect(created[0]?.priority).toBeUndefined();
    expect(created[0]?.labels).toContain('severity-medium');
    expect(created[0]?.description).toContain(
      'Серьёзность: medium (приоритета с таким именем в Jira нет)',
    );
  });

  it('Jira rejects the priority field → the same issue again without priority, not lost', async () => {
    const store = memory([[view('A defect', 'apps/web/a.tsx')]]);
    const rejected = Object.assign(new Error('Jira: 400'), {
      detail: JSON.stringify({
        errorMessages: [],
        errors: { priority: 'The priority selected is invalid.' },
      }),
    });
    const { api, created, attempts } = fakeTracker({
      reject: (issue) => (issue.priority ? rejected : undefined),
    });
    const result = await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api },
      input,
    );
    expect(attempts.map((issue) => issue.priority)).toEqual(['Medium', undefined]);
    expect(created).toHaveLength(1);
    expect(created[0]?.labels).toContain('severity-medium');
    expect(result.failed).toEqual([]);
    expect(result.issues[0]).toMatchObject({ key: 'PROJ-1', created: true });
    expect(result.issues[0]?.priority).toBeUndefined();
  });

  it('another 400 (not the priority) is not retried', async () => {
    const store = memory([[view('A defect', 'a.ts')]]);
    const other = Object.assign(new Error('Jira: 400'), {
      detail: JSON.stringify({ errors: { summary: 'too long' } }),
    });
    const { api, attempts } = fakeTracker({ reject: () => other });
    const result = await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api },
      input,
    );
    expect(attempts).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  it('Jira put a default assignee on its own → the result names it (the panel never sends one)', async () => {
    const store = memory([[view('A defect', 'a.ts')]]);
    const { api, created } = fakeTracker({ assignee: 'Project Lead' });
    const result = await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api },
      input,
    );
    expect(Object.keys(created[0] ?? {})).not.toContain('assignee');
    expect(result.issues[0]?.assignee).toBe('Project Lead');
  });
});

describe('priorityRejected', () => {
  it('reads Jira field errors; a cut body still counts; other fields and plain errors do not', () => {
    expect(priorityRejected({ detail: '{"errors":{"priority":"bad"}}' })).toBe(true);
    expect(
      priorityRejected({
        detail: '{"errorMessages":[],"errors":{"priority":"Field \'priority\' cannot be set',
      }),
    ).toBe(true);
    expect(priorityRejected({ detail: '{"errors":{"labels":"bad"}}' })).toBe(false);
    expect(priorityRejected(new Error('priority'))).toBe(false);
    expect(priorityRejected(undefined)).toBe(false);
  });
});

describe('findDuplicates — open Jira issues with the same meaning, shown before publishing', () => {
  const clusters = clusterSplitTickets([
    row('Падает экспорт отчёта в CSV', 'apps/web/src/export.ts:42'),
    row('Кнопка «Сохранить» не нажимается', 'apps/web/src/save.tsx:7'),
    row('Утечка дескрипторов файлов', 'apps/server/src/files.ts:3'),
  ]);

  /** Память панели в оперативке: какие отпечатки за какой задачей. */
  const memoryOf = (rows: Record<string, string[]>): TicketPrints => ({
    of: (key) => new Set((rows[key] ?? []).map(fingerprintOf)),
    remember: () => {},
    issuesWith: (prints) =>
      Object.keys(rows).filter((key) => rows[key]!.some((k) => prints.includes(fingerprintOf(k)))),
  });

  it('fingerprint, near title in the latest open, similar title via project search; unrelated stay out', async () => {
    const save = clusters[1]!.tickets[0]!;
    const { api, similarQueries } = fakeTracker({
      open: [
        { key: 'PROJ-7', summary: 'Экспорт отчёта в CSV падает', description: '' },
        {
          key: 'PROJ-8',
          summary: 'переименовано',
          // Задача, заведённая до 26.10.2026: строка отпечатка ещё в тексте, читается.
          description: `${FINGERPRINT_PREFIX} ${fingerprintOf(save.key)}`,
        },
      ],
      similar: [
        { key: 'PROJ-2', summary: 'Утечка дескрипторов при загрузке', description: '' },
        { key: 'PROJ-3', summary: 'Совсем другое про файлы', description: '' },
      ],
    });
    const found = await findDuplicates(api, 'PROJ', clusters);
    expect(found.map((item) => [item.title, item.issue.key, item.reason])).toEqual([
      ['Падает экспорт отчёта в CSV', 'PROJ-7', 'title'],
      ['Кнопка «Сохранить» не нажимается', 'PROJ-8', 'fingerprint'],
      ['Утечка дескрипторов файлов', 'PROJ-2', 'similar'],
    ]);
    expect(found[2]?.issue.url).toBe('https://tracker.example.com/browse/PROJ-2');
    // Поиск по проекту — только для дефекта, которого нет в последних открытых.
    expect(similarQueries).toHaveLength(1);
    expect(similarQueries[0]?.words).toEqual(['утечка', 'дескрипторов', 'файлов']);
    expect(similarQueries[0]?.prints).toHaveLength(1);
    expect(similarQueries[0]?.keys).toEqual([]);
  });

  it('panel memory: a print remembered behind an issue finds it, and its key goes into the project search', async () => {
    const save = clusters[1]!.tickets[0]!;
    const leak = clusters[2]!.tickets[0]!;
    const { api, similarQueries } = fakeTracker({
      open: [{ key: 'PROJ-8', summary: 'переименовано человеком', description: '' }],
      similar: [{ key: 'PROJ-40', summary: 'тоже переименовано', description: '' }],
    });
    const memory = memoryOf({ 'PROJ-8': [save.key], 'PROJ-40': [leak.key] });
    const found = await findDuplicates(api, 'PROJ', clusters, memory);
    expect(found.map((item) => [item.title, item.issue.key, item.reason])).toEqual([
      ['Кнопка «Сохранить» не нажимается', 'PROJ-8', 'fingerprint'],
      ['Утечка дескрипторов файлов', 'PROJ-40', 'fingerprint'],
    ]);
    const leakQuery = similarQueries.find((query) =>
      query.prints.includes(fingerprintOf(leak.key)),
    );
    expect(leakQuery?.keys).toEqual(['PROJ-40']);
  });

  it('nothing similar → nothing shown', async () => {
    const { api } = fakeTracker({
      open: [{ key: 'PROJ-1', summary: 'Импорт пользователей из LDAP', description: '' }],
    });
    expect(await findDuplicates(api, 'PROJ', clusters)).toEqual([]);
  });

  it('a link decision with a key of another project or garbage is dropped', () => {
    const key = clusters[0]!.tickets[0]!.key;
    const decisions = decisionsByCluster(
      clusters,
      [
        { proposal: key, choice: 'link', issueKey: 'OTHER-1' },
        { proposal: 'invented', choice: 'skip' },
        { proposal: clusters[1]!.tickets[0]!.key, choice: 'link', issueKey: 'proj-5' },
      ],
      'PROJ',
    );
    expect([...decisions]).toEqual([['C2', { choice: 'link', issueKey: 'PROJ-5' }]]);
  });
});

describe('publishTickets — the human decision on a likely duplicate', () => {
  const groups = () => [
    [
      view('Падает экспорт отчёта в CSV', 'apps/web/src/export.ts:42'),
      view('Кнопка «Сохранить» не нажимается', 'apps/web/src/save.tsx:7'),
      view('Утечка дескрипторов файлов', 'apps/server/src/files.ts:3'),
    ],
  ];
  const keyOf = (title: string, where: string) => splitTicketKey({ title, where });
  const exportKey = keyOf('Падает экспорт отчёта в CSV', 'apps/web/src/export.ts:42');
  const saveKey = keyOf('Кнопка «Сохранить» не нажимается', 'apps/web/src/save.tsx:7');
  const leakKey = keyOf('Утечка дескрипторов файлов', 'apps/server/src/files.ts:3');

  it('link → comment into the chosen issue; skip → nothing written, stays open; create → new issue despite the match', async () => {
    const store = memory(groups());
    const { api, created, comments } = fakeTracker({
      // Экспорт сервер склеил бы сам — «завести всё равно» эту сверку снимает.
      open: [{ key: 'PROJ-7', summary: 'Экспорт отчёта в CSV падает', description: '' }],
    });
    const result = await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api },
      {
        ...input,
        duplicates: [
          { proposal: exportKey, choice: 'create', issueKey: 'PROJ-7' },
          { proposal: saveKey, choice: 'skip', issueKey: 'PROJ-8' },
          { proposal: leakKey, choice: 'link', issueKey: 'PROJ-2' },
        ],
      },
    );

    expect(comments.map((comment) => comment.key)).toEqual(['PROJ-2']);
    expect(comments[0]?.body).toContain('Утечка дескрипторов файлов');
    expect(created.map((issue) => issue.summary)).toEqual(['Падает экспорт отчёта в CSV']);
    expect(result.skipped).toEqual([
      {
        title: 'Кнопка «Сохранить» не нажимается',
        proposals: [saveKey],
        key: 'PROJ-8',
        url: 'https://tracker.example.com/browse/PROJ-8',
      },
    ]);
    const filed = store.peek().groups[0]?.tickets?.map((ticket) => ticket.filed?.key ?? null);
    expect(filed).toEqual(['PROJ-1', null, 'PROJ-2']);
  });

  it('without decisions the server still matches on its own (old clients keep working)', async () => {
    const store = memory(groups());
    const { api, created, comments } = fakeTracker({
      open: [{ key: 'PROJ-7', summary: 'Экспорт отчёта в CSV падает', description: '' }],
    });
    await publishTickets(
      { marks: new SplitTicketMarks(store), record: () => store.get(), tracker: api },
      input,
    );
    expect(comments.map((comment) => comment.key)).toEqual(['PROJ-7']);
    expect(created).toHaveLength(2);
  });

  it('every defect linked or skipped → no model pass, no search, nothing created', async () => {
    const store = memory([[view('Утечка дескрипторов файлов', 'apps/server/src/files.ts:3')]]);
    let asked = 0;
    const { api, created } = fakeTracker();
    const result = await publishTickets(
      {
        marks: new SplitTicketMarks(store),
        record: () => store.get(),
        tracker: api,
        ask: async () => {
          asked += 1;
          return '{}';
        },
      },
      { ...input, duplicates: [{ proposal: leakKey, choice: 'skip' }] },
    );
    expect(asked).toBe(0);
    expect(created).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });
});
