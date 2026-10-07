import { describe, it, expect, afterEach, vi } from 'vitest';
import { readMergeRequestStates } from './mr-state.ts';

/**
 * Состояние MR для хаба. Сеть подменена на уровне `fetch`; остальное —
 * настоящий путь `forgeGet` / `forgeGraphql` → `sendRequest`. Главное здесь —
 * ЧИСЛО запросов: план из нескольких MR одного проекта спрашивается одним.
 */

interface Call {
  url: string;
  body?: string;
}

function stub(answer: (call: Call) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
    const call = { url: String(url), ...(init?.body ? { body: init.body } : {}) };
    calls.push(call);
    const { status, body } = answer(call);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const gl = (iid: number) => `https://git.acme.local/team/app/-/merge_requests/${iid}`;

describe('readMergeRequestStates', () => {
  it('GitLab: три MR одного проекта — один запрос списка по iids', async () => {
    const calls = stub(() => ({
      status: 200,
      body: [
        { iid: 949, state: 'merged' },
        { iid: 950, state: 'opened' },
        { iid: 951, state: 'closed' },
      ],
    }));
    const { states, failed } = await readMergeRequestStates([gl(949), gl(950), gl(951)], 't');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/projects/team%2Fapp/merge_requests?');
    expect(calls[0]?.url).toContain('iids[]=949&iids[]=950&iids[]=951');
    expect(calls[0]?.url).toContain('state=all');
    // Ни веток обсуждения, ни конвейера: только список.
    expect(calls[0]?.url).not.toContain('discussions');
    expect(states.get(gl(949))).toBe('merged');
    expect(states.get(gl(950))).toBe('open');
    expect(states.get(gl(951))).toBe('closed');
    expect(failed).toEqual([]);
  });

  it('GitHub: PR одного репозитория — один запрос GraphQL, владелец и имя переменными', async () => {
    const calls = stub(() => ({
      status: 200,
      body: { data: { repository: { p7: { state: 'MERGED' }, p8: { state: 'OPEN' } } } },
    }));
    const pr = (n: number) => `https://github.com/acme/app/pull/${n}`;
    const { states } = await readMergeRequestStates([pr(7), pr(8)], 't');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.github.com/graphql');
    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      query: string;
      variables: Record<string, string>;
    };
    expect(sent.variables).toEqual({ owner: 'acme', name: 'app' });
    expect(sent.query).toContain('p7: pullRequest(number: 7) { state }');
    expect(sent.query).not.toContain('reviewThreads');
    expect(states.get(pr(7))).toBe('merged');
    expect(states.get(pr(8))).toBe('open');
  });

  it('отказ одного проекта не роняет другой; чужая ссылка и пропавший MR — неизвестны', async () => {
    stub((call) =>
      call.url.includes('team%2Fbroken')
        ? { status: 500, body: { message: 'boom' } }
        : { status: 200, body: [{ iid: 1, state: 'merged' }] },
    );
    const broken = 'https://git.acme.local/team/broken/-/merge_requests/5';
    const { states, failed } = await readMergeRequestStates(
      [gl(1), gl(2), broken, 'https://example.com/not-a-mr'],
      't',
    );
    expect(states.get(gl(1))).toBe('merged');
    expect(states.has(gl(2))).toBe(false);
    expect(states.has(broken)).toBe(false);
    expect(failed).toHaveLength(1);
  });
});
