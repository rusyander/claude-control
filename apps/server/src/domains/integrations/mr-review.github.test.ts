import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readMergeRequestReview } from './mr-review.ts';
import { mrWatchPrompt, pendingThreads } from '../chat/mr-watch.ts';

/**
 * PR GitHub в наблюдателе MR (WP1j: «open: GitHub PRs»). До правки чтение для
 * GitHub отвечало `undefined`, и наблюдатель молчал о ревью и красных проверках
 * PR. «Ветка решена» у GitHub видна только через GraphQL (`reviewThreads.isResolved`),
 * исход проверок — через `statusCheckRollup` головы PR.
 *
 * Фордж — настоящий HTTP-сервер на 127.0.0.1: ссылка `http://127.0.0.1:N/o/r/pull/5`
 * разбирается как GitHub своей инсталляции (GraphQL на `/api/graphql`), запрос
 * идёт настоящим `fetch` через `sendRequest`.
 */

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: { query?: string; variables?: Record<string, unknown> };
}

let server: Server;
let base: string;
let seen: Seen[];
let answer: (variables: Record<string, unknown>) => unknown;

beforeEach(async () => {
  seen = [];
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Seen['body']) : {};
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        auth: request.headers.authorization,
        body,
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(answer(body.variables ?? {})));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const human = (login: string) => ({ login, __typename: 'User' });

function comment(id: number, author: { login: string; __typename: string }, body: string) {
  return {
    databaseId: id,
    body,
    createdAt: '2026-09-25T10:00:00Z',
    url: `${base}/o/r/pull/5#discussion_r${id}`,
    author,
  };
}

function page(input: {
  state?: string;
  rollup?: string | null;
  threads: unknown[];
  next?: string;
}): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          state: input.state ?? 'OPEN',
          url: `${base}/o/r/pull/5`,
          author: human('group-bot-user'),
          body: 'Что и зачем.',
          commits: {
            nodes: [
              {
                commit: {
                  oid: 'abc123',
                  statusCheckRollup:
                    input.rollup === null ? null : { state: input.rollup ?? 'SUCCESS' },
                },
              },
            ],
          },
          reviewThreads: {
            pageInfo: { hasNextPage: Boolean(input.next), endCursor: input.next ?? null },
            nodes: input.threads,
          },
        },
      },
    },
  };
}

describe('readMergeRequestReview (GitHub)', () => {
  it('ветки ревью, автор PR, исход проверок головы — через GraphQL, постранично', async () => {
    answer = (variables) =>
      variables.cursor === 'page-2'
        ? page({
            rollup: 'FAILURE',
            threads: [
              {
                id: 'T3',
                isResolved: false,
                path: 'b.ts',
                line: null,
                originalLine: 7,
                comments: {
                  nodes: [comment(30, { login: 'github-actions', __typename: 'Bot' }, 'lint')],
                },
              },
            ],
          })
        : page({
            rollup: 'FAILURE',
            next: 'page-2',
            threads: [
              {
                id: 'T1',
                isResolved: false,
                path: 'src/a.ts',
                line: 12,
                comments: {
                  nodes: [
                    comment(10, human('reviewer'), 'Тут гонка'),
                    comment(11, human('group-bot-user'), 'Поправил'),
                    comment(12, human('reviewer'), 'Не до конца'),
                  ],
                },
              },
              {
                id: 'T2',
                isResolved: true,
                path: 'src/a.ts',
                line: 40,
                comments: { nodes: [comment(20, human('reviewer'), 'ок')] },
              },
            ],
          });

    const review = await readMergeRequestReview(`${base}/o/r/pull/5`, 'T0K');

    expect(seen).toHaveLength(2);
    expect(seen.every((call) => call.method === 'POST' && call.url === '/api/graphql')).toBe(true);
    expect(seen[0]?.auth).toBe('Bearer T0K');
    expect(seen[0]?.body.variables).toMatchObject({ owner: 'o', name: 'r', number: 5 });
    expect(seen[1]?.body.variables).toMatchObject({ cursor: 'page-2' });

    // Описание PR — часть готовности группы (аудит 25.09, L110).
    expect(review).toMatchObject({
      state: 'open',
      author: 'group-bot-user',
      description: 'Что и зачем.',
    });
    expect(review?.pipeline).toEqual({
      id: 'abc123',
      status: 'failed',
      url: `${base}/o/r/pull/5/checks`,
    });
    expect(
      review?.threads.map((thread) => [thread.id, thread.resolvable, thread.resolved]),
    ).toEqual([
      ['T1', true, false],
      ['T2', true, true],
      ['T3', true, false],
    ]);
    expect(review?.threads[0]).toMatchObject({ path: 'src/a.ts', line: 12 });
    expect(review?.threads[0]?.notes.map((note) => [note.id, note.author])).toEqual([
      ['10', 'reviewer'],
      ['11', 'group-bot-user'],
      ['12', 'reviewer'],
    ]);
    expect(review?.threads[2]).toMatchObject({ line: 7 });
    expect(review?.threads[2]?.notes[0]?.bot).toBe(true);

    // Дальше — наблюдатель как есть: ждёт группу только T1 (T2 решена, T3 — бот),
    // и ссылка на реплику — якорь GitHub, а не `#note_` GitLab.
    const pending = pendingThreads(review!, []);
    expect(pending.map((thread) => thread.id)).toEqual(['T1']);
    const prompt = mrWatchPrompt({
      branch: 'feature/x',
      mr: `${base}/o/r/pull/5`,
      threads: pending,
      red: review?.pipeline,
    });
    expect(prompt).toContain(`${base}/o/r/pull/5#discussion_r12`);
    expect(prompt).not.toContain('#note_');
  });

  it('исходы проверок и состояния PR — словами наблюдателя', async () => {
    const cases: [string | null, string, string | undefined, string][] = [
      ['SUCCESS', 'MERGED', 'success', 'merged'],
      ['PENDING', 'OPEN', 'running', 'open'],
      ['EXPECTED', 'OPEN', 'running', 'open'],
      ['ERROR', 'CLOSED', 'failed', 'closed'],
      [null, 'OPEN', undefined, 'open'],
    ];
    for (const [rollup, state, status, mapped] of cases) {
      answer = () => page({ rollup, state, threads: [] });
      const review = await readMergeRequestReview(`${base}/o/r/pull/5`, 'T');
      expect(review?.state).toBe(mapped);
      expect(review?.pipeline?.status).toBe(status);
    }
  });

  it('ошибка GraphQL (200 с `errors`) бросается, а не читается как «замечаний нет»', async () => {
    answer = () => ({ data: null, errors: [{ message: 'Could not resolve to a Repository' }] });

    await expect(readMergeRequestReview(`${base}/o/r/pull/5`, 'T')).rejects.toThrow(
      /Could not resolve/,
    );
  });

  it('PR не нашёлся — бросается тоже', async () => {
    answer = () => ({ data: { repository: { pullRequest: null } } });

    await expect(readMergeRequestReview(`${base}/o/r/pull/5`, 'T')).rejects.toThrow();
  });
});
