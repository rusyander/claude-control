import { describe, it, expect, afterEach, vi } from 'vitest';
import { retryMergeRequestJob } from '../forge.ts';
import { isBotName, readMergeRequestReview } from './mr-review.ts';

/**
 * Чтение MR для наблюдателя (WP1j). Сеть подменена на уровне `fetch`: ответы —
 * в форме GitLab API v4 (`/merge_requests/:iid`, `/discussions`), остальное —
 * настоящий путь `forgeGet` → `sendRequest`.
 */

const MR = 'https://git.acme.local/team/app/-/merge_requests/810';

function stubApi(routes: [RegExp, unknown][]): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push(`${init?.method && init.method !== 'GET' ? `${init.method} ` : ''}${String(url)}`);
    const found = routes.find(([pattern]) => pattern.test(String(url)));
    return Promise.resolve(
      found
        ? new Response(JSON.stringify(found[1]), { status: 200 })
        : new Response(JSON.stringify({ message: '404 Not Found' }), { status: 404 }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = (username: string, bot?: boolean) => ({ username, ...(bot ? { bot } : {}) });

describe('readMergeRequestReview (GitLab)', () => {
  it('ветки, автор, конвейер головы; служебные реплики выброшены', async () => {
    const calls = stubApi([
      [
        /merge_requests\/810\/discussions\?per_page=100&page=1$/,
        [
          {
            id: 'd-open',
            notes: [
              {
                id: 17928,
                body: '🔴 attachRef',
                author: USER('simonenko'),
                system: false,
                resolvable: true,
                resolved: false,
                created_at: '2026-09-24T17:09:00Z',
                position: { new_path: 'src/Menu.tsx', new_line: 42 },
              },
            ],
          },
          {
            id: 'd-resolved',
            notes: [
              { id: 1, body: 'x', author: USER('simonenko'), resolvable: true, resolved: true },
              { id: 2, body: 'y', author: USER('rustam'), resolvable: true, resolved: true },
            ],
          },
          {
            id: 'd-system',
            notes: [{ id: 3, body: 'added 1 commit', author: USER('rustam'), system: true }],
          },
          {
            id: 'd-bot',
            notes: [
              {
                id: 4,
                body: 'lint',
                author: USER('project_12_bot_7f'),
                resolvable: true,
                resolved: false,
              },
            ],
          },
        ],
      ],
      [
        /merge_requests\/810$/,
        {
          state: 'opened',
          author: USER('rustam'),
          description: 'Что и зачем.',
          has_conflicts: true,
          head_pipeline: { id: 7763, status: 'failed', web_url: 'https://git.acme.local/p/7763' },
        },
      ],
    ]);

    const got = await readMergeRequestReview(MR, 'T');

    expect(calls[0]).toBe('https://git.acme.local/api/v4/projects/team%2Fapp/merge_requests/810');
    expect(got).toEqual({
      state: 'open',
      author: 'rustam',
      // Описание MR — часть готовности группы (аудит 25.09, L110).
      description: 'Что и зачем.',
      // Конфликт с целевой веткой — для «Перепроверить MR» (владелец 05.10).
      conflicts: true,
      pipeline: { id: '7763', status: 'failed', url: 'https://git.acme.local/p/7763' },
      threads: [
        {
          id: 'd-open',
          resolvable: true,
          resolved: false,
          path: 'src/Menu.tsx',
          line: 42,
          notes: [
            {
              id: '17928',
              author: 'simonenko',
              body: '🔴 attachRef',
              createdAt: '2026-09-24T17:09:00Z',
            },
          ],
        },
        {
          id: 'd-resolved',
          resolvable: true,
          resolved: true,
          notes: [
            { id: '1', author: 'simonenko', body: 'x' },
            { id: '2', author: 'rustam', body: 'y' },
          ],
        },
        {
          id: 'd-bot',
          resolvable: true,
          resolved: false,
          notes: [{ id: '4', author: 'project_12_bot_7f', bot: true, body: 'lint' }],
        },
      ],
    });
  });

  it('красный конвейер — упавшие задания с причиной GitLab; allow_failure не считается', async () => {
    const calls = stubApi([
      [/discussions\?per_page=100&page=1$/, []],
      [
        /pipelines\/7763\/jobs\?scope\[\]=failed&per_page=100$/,
        [
          {
            id: 51,
            name: 'lint-frontend',
            failure_reason: 'runner_system_failure',
            web_url: 'https://git.acme.local/j/51',
          },
          { id: 52, name: 'docs-gate', failure_reason: 'script_failure' },
          { id: 53, name: 'optional', failure_reason: 'script_failure', allow_failure: true },
        ],
      ],
      [/merge_requests\/810$/, { state: 'opened', head_pipeline: { id: 7763, status: 'failed' } }],
    ]);

    const got = await readMergeRequestReview(MR, 'T');

    expect(calls.some((url) => url.includes('/pipelines/7763/jobs?scope[]=failed'))).toBe(true);
    expect(got?.pipeline?.failedJobs).toEqual([
      {
        id: '51',
        name: 'lint-frontend',
        reason: 'runner_system_failure',
        url: 'https://git.acme.local/j/51',
      },
      { id: '52', name: 'docs-gate', reason: 'script_failure' },
    ]);
  });

  it('влитой MR и MR без конвейера; обсуждения читаются постранично', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `d${from + i}`,
        notes: [{ id: from + i, body: 'b', author: USER('a'), resolvable: true, resolved: true }],
      }));
    const calls = stubApi([
      [/discussions\?per_page=100&page=1$/, page(0, 100)],
      [/discussions\?per_page=100&page=2$/, page(100, 3)],
      [/merge_requests\/810$/, { state: 'merged', author: USER('rustam'), head_pipeline: null }],
    ]);

    const got = await readMergeRequestReview(MR, 'T');

    expect(got?.state).toBe('merged');
    expect(got?.pipeline).toBeUndefined();
    expect(got?.threads).toHaveLength(103);
    expect(calls.filter((url) => url.includes('/discussions'))).toHaveLength(2);
  });

  it('отказ форджа бросается, а не читается как «замечаний нет»', async () => {
    stubApi([]);
    await expect(readMergeRequestReview(MR, 'T')).rejects.toThrow();
  });

  // PR GitHub читается GraphQL — `mr-review.github.test.ts`.
  it('не-ссылка — читать нечем, в сеть не ходим', async () => {
    const calls = stubApi([]);
    await expect(readMergeRequestReview('https://example.com/x', 'T')).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('retryMergeRequestJob', () => {
  it('GitLab: POST повтора задания в проект MR', async () => {
    const calls = stubApi([[/jobs\/51\/retry$/, { id: 54 }]]);
    await expect(retryMergeRequestJob(MR, 'T', '51')).resolves.toBe(true);
    expect(calls).toEqual(['POST https://git.acme.local/api/v4/projects/team%2Fapp/jobs/51/retry']);
  });

  it('GitHub и не-ссылка — повторять нечем, в сеть не ходим', async () => {
    const calls = stubApi([]);
    await expect(retryMergeRequestJob('https://github.com/o/r/pull/3', 'T', '51')).resolves.toBe(
      false,
    );
    await expect(retryMergeRequestJob('https://example.com/x', 'T', '51')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('isBotName', () => {
  it('служебные учётные записи — боты, люди — нет', () => {
    for (const name of ['project_12_bot_7f', 'group_3_bot', 'ci-bot', 'renovate[bot]', 'ghost']) {
      expect(isBotName(name), name).toBe(true);
    }
    for (const name of ['simonenko', 'rustam', 'abbot', 'botanik', 'robot']) {
      expect(isBotName(name), name).toBe(false);
    }
  });
});
