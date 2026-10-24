import { describe, expect, it } from 'vitest';
import {
  bundleSplitTickets,
  clusterSplitTickets,
  MAX_BUNDLE_DEFECTS,
  whereFiles,
  type OpenSplitTicket,
} from '@agentdeck/contracts/split-ticket-batch';
import { splitTicketKey, type SplitTicketView } from '@agentdeck/contracts/split-tickets';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { commentBody, fingerprintLine, fingerprintOf, issueDescription } from './compose.ts';
import { splitByExisting, type OpenTrackerIssue } from './existing.ts';
import { draftsFromReply, fallbackDraft } from './prepare.ts';
import { publishTickets, type BatchIssueInput, type BatchTracker } from './publish.ts';
import { SplitTicketMarks } from './ticket-marks.ts';

/**
 * Ревизия 3: склейка повторов, связки, описание по разделам и сверка с
 * открытыми задачами — таблицей, без сети и модели. Каждая строка «не
 * склеивать» стоит рядом со склеивающей: порог, который склеивает всё, здесь краснеет.
 */

const row = (title: string, where: string, why = 'why', groups = ['G']): OpenSplitTicket => ({
  key: splitTicketKey({ title, where }),
  title,
  where,
  why,
  groups,
});

const titlesOf = (tickets: readonly OpenSplitTicket[]) =>
  clusterSplitTickets(tickets).map((cluster) => cluster.tickets.map((ticket) => ticket.title));

describe('clusterSplitTickets — duplicates within the batch', () => {
  it.each([
    {
      name: 'near-duplicate wording, different places → one defect',
      a: row('Go tests fail on Windows', 'server/go_test.go:12'),
      b: row('Windows: go tests failing', 'ci/pipeline.yml'),
      merged: true,
    },
    {
      name: 'Russian word order swapped → one defect',
      a: row('Падает экспорт отчёта в CSV', 'web'),
      b: row('Экспорт отчёта в CSV падает', 'server'),
      merged: true,
    },
    {
      name: 'same file, same symptom in other words → one defect',
      a: row('Export crashes on empty list', 'src/export.ts:10'),
      b: row('Export crash when list is empty', 'src/export.ts:40'),
      merged: true,
    },
    {
      name: 'same file lowers the bar: 3 of 5 stems shared → one defect',
      a: row('Export button misaligned on mobile', 'src/export.tsx:10'),
      b: row('Export button misaligned in dialog', 'src/export.tsx:55'),
      merged: true,
    },
    {
      name: 'same 3 of 5 stems in different files → two defects',
      a: row('Export button misaligned on mobile', 'src/export.tsx:10'),
      b: row('Export button misaligned in dialog', 'src/dialog.tsx:55'),
      merged: false,
    },
    {
      name: 'same file, two shared stems but mostly different words → two defects',
      a: row('Export ignores date filter', 'src/export.ts:10'),
      b: row('Export date column wrong width', 'src/export.ts:70'),
      merged: false,
    },
    {
      name: 'Russian case endings differ (отчёта / отчётов) → one defect',
      a: row('Падает экспорт отчёта в CSV', 'web'),
      b: row('Падает экспорт отчётов в формате CSV', 'server'),
      merged: true,
    },
    {
      name: 'same exact place, unrelated words → one defect (pre-R3 rule kept)',
      a: row('Tests flaky', 'server/go_test.go:12'),
      b: row('Different words', 'server/go_test.go:12'),
      merged: true,
    },
    {
      name: 'one key word differs (export vs import), different places → two defects',
      a: row('Export button fails on Windows', 'web/export.tsx'),
      b: row('Import button fails on Windows', 'web/import.tsx'),
      merged: false,
    },
    {
      name: 'same file, different defects → two defects (bundled, not merged)',
      a: row('Export ignores the date filter', 'src/export.ts:10'),
      b: row('Export leaks file handles', 'src/export.ts:88'),
      merged: false,
    },
    {
      name: 'only one meaningful shared word → two defects',
      a: row('Fix it', 'a'),
      b: row('Fix it now please', 'b'),
      merged: false,
    },
    {
      name: 'same short where («web») is not a place → two defects',
      a: row('Help links factory', 'web'),
      b: row('Unrelated thing', 'web'),
      merged: false,
    },
  ])('$name', ({ a, b, merged }) => {
    expect(titlesOf([a, b])).toHaveLength(merged ? 1 : 2);
  });

  it('merges are transitive and keep first-appearance order', () => {
    expect(
      titlesOf([
        row('Go tests fail on Windows', 'server/go_test.go:12'),
        row('Other defect entirely', 'web'),
        row('Different words', 'server/go_test.go:12'),
        row('Windows: go tests failing', 'ci.yml'),
      ]),
    ).toEqual([
      ['Go tests fail on Windows', 'Different words', 'Windows: go tests failing'],
      ['Other defect entirely'],
    ]);
  });
});

describe('whereFiles + bundleSplitTickets — related defects become one issue', () => {
  it('file paths: line/column dropped, slashes and case normalised; words are not files', () => {
    expect(whereFiles('apps/Server/a.ts:12:4, b.go')).toEqual(['apps/server/a.ts', 'b.go']);
    expect(whereFiles('.\\apps\\web\\App.tsx:3')).toEqual(['apps/web/app.tsx']);
    expect(whereFiles('экран настроек, web, v1.2')).toEqual([]);
  });

  it('different defects of one file → one bundle naming the file; a defect without a file stays alone', () => {
    const bundles = bundleSplitTickets(
      clusterSplitTickets([
        row('Export ignores the date filter', 'src/export.ts:10'),
        row('Settings page jumps on save', 'web'),
        row('Export leaks file handles', './src/export.ts:88'),
      ]),
    );
    expect(bundles.map((bundle) => bundle.clusters.length)).toEqual([2, 1]);
    expect(bundles[0]?.files).toEqual(['src/export.ts']);
    expect(bundles[1]?.files).toEqual([]);
    expect(bundles.map((bundle) => bundle.id)).toEqual(['B1', 'B2']);
  });

  it(`more than ${MAX_BUNDLE_DEFECTS} defects in one file → next bundle, nothing lost`, () => {
    const titles = [
      'Login ignores remember flag',
      'Avatar upload freezes browser',
      'Pagination skips last page',
      'Timezone shifts report dates',
      'Search highlights wrong tokens',
      'Logout keeps stale cookie',
      'Sorting drops pinned rows',
    ];
    expect(titles).toHaveLength(MAX_BUNDLE_DEFECTS + 1);
    const many = titles.map((title, index) => row(title, `src/big.ts:${index + 1}`));
    const bundles = bundleSplitTickets(clusterSplitTickets(many));
    expect(bundles.map((bundle) => bundle.clusters.length)).toEqual([MAX_BUNDLE_DEFECTS, 1]);
  });
});

describe('model output on bundles; description is the server’s sections', () => {
  const bundles = bundleSplitTickets(
    clusterSplitTickets([
      row('Export ignores the date filter', 'src/export.ts:10'),
      row('Export leaks file handles', 'src/export.ts:88'),
      row('Settings page jumps on save', 'web/settings.tsx'),
    ]),
  );

  it('a model cannot split a bundle; details of a foreign or empty defect are dropped', () => {
    const reply = JSON.stringify({
      issues: [
        {
          title: 'Export: filter and handles',
          summary: 'Export is unreliable.',
          sources: ['C1'],
          problems: [
            { id: 'c1', repro: 'Export with a date range', expected: 'rows in range', actual: '' },
            { id: 'C3', repro: 'belongs to another issue' },
            { id: 'C2', repro: '', expected: '', actual: '' },
          ],
        },
        { title: 'Steals C2', sources: ['C2'] },
        { title: 'Settings', sources: ['B2'] },
      ],
    });
    const drafts = draftsFromReply(reply, bundles, 'en');
    expect(drafts?.map((draft) => draft.title)).toEqual(['Export: filter and handles', 'Settings']);
    expect(drafts?.[0]?.clusters.map((cluster) => cluster.id)).toEqual(['C1', 'C2']);
    expect([...(drafts?.[0]?.details.keys() ?? [])]).toEqual(['C1']);

    const text = issueDescription(drafts![0]!, 'en');
    expect(text.split('\n\n')).toEqual([
      'Export is unreliable.',
      [
        '1. Export ignores the date filter',
        'Where: src/export.ts:10',
        'Evidence: why',
        'Steps: Export with a date range',
        'Expected: rows in range',
        'Found by groups: G',
      ].join('\n'),
      [
        '2. Export leaks file handles',
        'Where: src/export.ts:88',
        'Evidence: why',
        'Found by groups: G',
      ].join('\n'),
      fingerprintLine(drafts![0]!.clusters.flatMap((c) => c.tickets.map((t) => t.key))),
    ]);
    // Модель не сказала «на деле» — строки нет, а не пустая или выдуманная.
    expect(text).not.toContain('Actual:');
  });

  it('without a model: one issue per bundle, title names the file and how many more', () => {
    expect(fallbackDraft(bundles[0]!, 'ru').title).toBe(
      'export.ts: Export ignores the date filter и ещё 1',
    );
    expect(fallbackDraft(bundles[1]!, 'en').title).toBe('Settings page jumps on save');
  });
});

describe('splitByExisting — open tracker tickets get a comment, never a copy', () => {
  const draftOf = (...tickets: OpenSplitTicket[]) =>
    fallbackDraft(bundleSplitTickets(clusterSplitTickets(tickets))[0]!, 'en');
  const issue = (key: string, summary: string, description = ''): OpenTrackerIssue => ({
    key,
    summary,
    description,
  });

  it('fingerprint in an open issue matches even when its summary was rewritten', () => {
    const a = row('Go tests fail on Windows', 'server/go_test.go:12');
    const split = splitByExisting(draftOf(a), [
      issue('PROJ-3', 'Something unrelated'),
      issue('PROJ-7', 'CI on Windows: renamed by a human', `text\n\n${fingerprintLine([a.key])}`),
    ]);
    expect(split.comments.map((match) => match.issue.key)).toEqual(['PROJ-7']);
    expect(split.rest).toBeUndefined();
  });

  it('a human-filed issue with near-duplicate summary matches', () => {
    const split = splitByExisting(draftOf(row('Go tests fail on Windows', 'x.go')), [
      issue('PROJ-9', 'Go tests failing on Windows runners'),
    ]);
    expect(split.comments.map((match) => match.issue.key)).toEqual(['PROJ-9']);
  });

  it('no false match: one key word differs, no fingerprint → new issue', () => {
    const draft = draftOf(row('Export button fails on Windows', 'web/export.tsx'));
    const split = splitByExisting(draft, [issue('PROJ-2', 'Import button fails on Windows')]);
    expect(split.comments).toEqual([]);
    expect(split.rest).toBe(draft);
  });

  it('a bundle with one defect already open: that defect → comment, the rest → new issue with its own title', () => {
    const draft = draftOf(
      row('Export ignores the date filter', 'src/export.ts:10'),
      row('Export leaks file handles', 'src/export.ts:88'),
    );
    const split = splitByExisting(draft, [issue('PROJ-5', 'Export ignores date filter')]);
    expect(split.comments.map((match) => match.clusters.map((c) => c.tickets[0]?.title))).toEqual([
      ['Export ignores the date filter'],
    ]);
    expect(split.rest?.title).toBe('Export leaks file handles');
    expect(split.rest?.clusters).toHaveLength(1);
  });
});

describe('publishTickets — search first, then comment or create', () => {
  const at = '2026-10-24T10:00:00.000Z';
  const view = (title: string, where: string): SplitTicketView => ({
    title,
    where,
    why: 'why',
    at,
  });

  function store(groups: SplitTicketView[][]) {
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

  function tracker(open: OpenTrackerIssue[], searchFails = () => false) {
    const created: BatchIssueInput[] = [];
    const comments: { key: string; body: string }[] = [];
    let searches = 0;
    const api: BatchTracker = {
      priorities: async () => [],
      searchOpen: async () => {
        searches += 1;
        if (searchFails()) throw new Error('Jira 503');
        return open;
      },
      create: async (input) => {
        created.push(input);
        return `PROJ-${100 + created.length}`;
      },
      comment: async (key, body) => {
        comments.push({ key, body });
      },
      issueUrl: (key) => `https://tracker.example.com/browse/${key}`,
    };
    return { api, created, comments, searches: () => searches };
  }

  it('open issue matched → comment with sections + fingerprints, marks filed with its key; the rest is created', async () => {
    const records = store([
      [view('Go tests fail on Windows', 'server/go_test.go:12'), view('Help link 404', 'web')],
      [view('Windows: go tests failing', 'ci.yml')],
    ]);
    const marks = new SplitTicketMarks(records);
    const { api, created, comments } = tracker([
      { key: 'PROJ-7', summary: 'Go tests fail on Windows', description: '' },
    ]);
    const result = await publishTickets(
      { marks, record: () => records.get(), tracker: api },
      { parentChatId: 'p', projectKey: 'PROJ', issueType: 'Bug', lang: 'en' },
    );

    expect(comments.map((comment) => comment.key)).toEqual(['PROJ-7']);
    expect(comments[0]?.body).toContain('The split groups found this again');
    expect(comments[0]?.body).toContain(
      'Same defect in other words: «Windows: go tests failing» (ci.yml)',
    );
    expect(comments[0]?.body).toContain(
      fingerprintOf(
        splitTicketKey({ title: 'Go tests fail on Windows', where: 'server/go_test.go:12' }),
      ),
    );
    expect(created.map((issue) => issue.summary)).toEqual(['Help link 404']);
    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'PROJ-7',
        created: false,
        commented: true,
        defects: [{ title: 'Go tests fail on Windows', duplicates: ['Windows: go tests failing'] }],
      }),
      expect.objectContaining({ key: 'PROJ-101', created: true }),
    ]);
    const filed = records.peek().groups.map((group) => group.tickets?.map((x) => x.filed?.key));
    expect(filed).toEqual([['PROJ-7', 'PROJ-101'], ['PROJ-7']]);
  });

  it('search fails → nothing filed, all listed with the reason; retry searches again and files', async () => {
    const records = store([[view('A defect here', 'a.ts:1')]]);
    const marks = new SplitTicketMarks(records);
    let down = true;
    const { api, created, searches } = tracker([], () => down);
    const deps = { marks, record: () => records.get(), tracker: api };
    const input = { parentChatId: 'p', projectKey: 'PROJ', issueType: 'Bug', lang: 'en' as const };

    const first = await publishTickets(deps, input);
    expect(created).toEqual([]);
    expect(first.failed.map((row) => row.message)).toEqual(['Jira 503']);

    down = false;
    const retry = await publishTickets(deps, { ...input, retryFailed: true });
    expect(searches()).toBe(2);
    expect(retry.issues.map((issue) => issue.key)).toEqual(['PROJ-101']);
  });

  it('the issue just created is open for the rest of the same publish', () => {
    const description = issueDescription(
      {
        summary: '',
        clusters: clusterSplitTickets([row('A defect', 'a.ts')]),
        details: new Map(),
      },
      'en',
    );
    const again = commentBody(
      { summary: '', clusters: clusterSplitTickets([row('A defect', 'a.ts')]), details: new Map() },
      'en',
    );
    // Один и тот же отпечаток в описании и комментарии — сверка узнаёт оба.
    const print = fingerprintOf(splitTicketKey({ title: 'A defect', where: 'a.ts' }));
    expect(description).toContain(print);
    expect(again).toContain(print);
  });
});
