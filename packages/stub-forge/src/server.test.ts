import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closedPortUrl,
  REVIEW_THREAD_BODIES,
  startStubForge,
  type StubForge,
  type StubForgeOptions,
} from './index.mjs';

/**
 * Заглушка форжа — настоящий HTTP на loopback: подмножество GitLab и GitHub, пояс P63, сбои,
 * след без значений доступа. Переходники ядра судятся против неё; здесь — что она сама честна.
 */

let stub: StubForge | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await stub?.stop();
  stub = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(options: StubForgeOptions = {}): Promise<StubForge> {
  stub = await startStubForge(options);
  return stub;
}

/** Тело ответа заглушки в той форме, которую тест дальше сверяет `expect`. */
async function body<T>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

function call(
  s: StubForge,
  path: string,
  init: { method?: string; body?: unknown; as?: string; header?: 'gitlab' | 'github' } = {},
): Promise<Response> {
  const token = s.tokens[init.as ?? 'publisher'];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.as !== 'nobody') {
    if (init.header === 'github') headers.authorization = `Bearer ${token}`;
    else headers['private-token'] = token!;
  }
  return fetch(`${s.url}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe('stub-forge server', () => {
  it('serves the GitLab v4 MR, discussion and note subset with authors', async () => {
    const s = await start();
    const me = await (await call(s, '/api/v4/user')).json();
    expect(me).toMatchObject({ id: 1, username: 'publisher' });
    const created = await call(s, '/api/v4/projects/acme%2Fapp/merge_requests', {
      method: 'POST',
      body: {
        source_branch: 'feat',
        target_branch: 'main',
        title: 'Draft: Add x',
        description: 'b',
      },
    });
    expect(created.status).toBe(201);
    const mr = await created.json();
    expect(mr).toMatchObject({ iid: 1, draft: true, title: 'Draft: Add x', state: 'opened' });
    const list = await body<Array<{ iid: number }>>(
      call(s, '/api/v4/projects/101/merge_requests?source_branch=feat&author_id=1'),
    );
    expect(list.map((m: { iid: number }) => m.iid)).toEqual([1]);
    const none = await (
      await call(s, '/api/v4/projects/101/merge_requests?source_branch=feat&author_id=2')
    ).json();
    expect(none).toEqual([]);
    s.act('reviewer', { type: 'note', mrIid: 1, body: 'why?' });
    const threads = await body<Array<{ id: string }>>(
      call(s, '/api/v4/projects/101/merge_requests/1/discussions'),
    );
    expect(threads).toHaveLength(1);
    const id = threads[0]!.id;
    const reply = await call(s, `/api/v4/projects/101/merge_requests/1/discussions/${id}/notes`, {
      method: 'POST',
      body: { body: 'because' },
    });
    expect(reply.status).toBe(201);
    const resolved = await call(
      s,
      `/api/v4/projects/101/merge_requests/1/discussions/${id}?resolved=true`,
      { method: 'PUT' },
    );
    expect((await body<{ notes: unknown[] }>(resolved)).notes[1]).toMatchObject({
      body: 'because',
      resolved: true,
    });
    const types = s.state().events.map((e) => [e.type, e.authorId]);
    expect(types).toEqual([
      ['mr-open', 1],
      ['note', 2],
      ['note', 1],
    ]);
  });

  it('serves site-wide inbox reads: assigned issues with links and epic, MRs by reviewer and author', async () => {
    let now = 1_000;
    const s = await start({ now: () => (now += 1_000) });
    const open = (title: string, extra: Record<string, unknown> = {}) =>
      (
        s.act('reviewer', {
          type: 'issue-open',
          title,
          labels: ['core', 'ready'],
          assignees: ['publisher'],
          ...extra,
        }) as { iid: number }
      ).iid;
    const a = open('a', { epic: { id: 5, iid: 2, groupId: 7 } });
    const b = open('b');
    open('c', { labels: ['core'] });
    open('theirs', { assignees: ['reviewer'] });
    const closed = open('closed');
    s.act('reviewer', { type: 'issue-update', iid: closed, state: 'closed' });
    s.act('reviewer', { type: 'issue-link', iid: a, targetIid: b });

    type Issue = { iid: number; references: { full: string }; epic: { group_id: number } | null };
    const mine = await body<Issue[]>(
      call(s, '/api/v4/issues?scope=assigned_to_me&state=opened&labels=core,ready'),
    );
    expect(mine.map((i) => i.iid)).toEqual([b, a]);
    expect(mine[1]).toMatchObject({
      references: { full: `acme/app#${a}` },
      epic: { iid: 2, group_id: 7 },
    });
    // `scope` по умолчанию у GitLab — `created_by_me`: учётка publisher ничего не заводила.
    expect(await body<Issue[]>(call(s, '/api/v4/issues'))).toEqual([]);
    const paged = await body<Issue[]>(
      call(
        s,
        '/api/v4/issues?scope=assigned_to_me&state=opened&labels=core,ready&per_page=1&page=2',
      ),
    );
    expect(paged.map((i) => i.iid)).toEqual([a]);
    // Связь видна с обеих сторон.
    const fromB = await body<Issue[]>(call(s, `/api/v4/projects/101/issues/${b}/links`));
    expect(fromB.map((i) => i.iid)).toEqual([a]);
    expect((await call(s, '/api/v4/projects/101/issues/999')).status).toBe(404);

    const mr = (as: string, branch: string, reviewers?: string[]) =>
      (
        s.act(as, {
          type: 'mr-open',
          sourceBranch: branch,
          targetBranch: 'main',
          title: branch,
          labels: ['core'],
          ...(reviewers ? { reviewers } : {}),
        }) as { iid: number }
      ).iid;
    const review = mr('reviewer', 'r1', ['publisher']);
    mr('reviewer', 'r2');
    const own = mr('publisher', 'p1');
    const gone = mr('reviewer', 'r3', ['publisher']);
    s.act('reviewer', { type: 'mr-close', mrIid: gone });
    type Mr = { iid: number; reviewers: { username: string }[]; labels: string[] };
    const asked = await body<Mr[]>(
      call(s, '/api/v4/merge_requests?scope=all&state=opened&reviewer_username=publisher'),
    );
    expect(asked.map((m) => m.iid)).toEqual([review]);
    expect(asked[0]).toMatchObject({ reviewers: [{ username: 'publisher' }], labels: ['core'] });
    const byId = await body<Mr[]>(call(s, '/api/v4/merge_requests?scope=all&reviewer_id=1'));
    expect(byId.map((m) => m.iid)).toEqual([gone, review]);
    const mineMrs = await body<Mr[]>(call(s, '/api/v4/merge_requests?state=opened'));
    expect(mineMrs.map((m) => m.iid)).toEqual([own]);
    expect(s.state().issueLinks).toHaveLength(1);
  });

  it('pages MR discussions like GitLab: 20 by default, per_page up to 100', async () => {
    const s = await start();
    s.act('publisher', { type: 'mr-open', sourceBranch: 'f', targetBranch: 'main', title: 't' });
    for (let n = 0; n < 25; n += 1) s.act('reviewer', { type: 'note', mrIid: 1, body: `n${n}` });
    const path = '/api/v4/projects/101/merge_requests/1/discussions';
    expect(await body<unknown[]>(call(s, path))).toHaveLength(20);
    expect(await body<unknown[]>(call(s, `${path}?page=2`))).toHaveLength(5);
    expect(await body<unknown[]>(call(s, `${path}?per_page=100`))).toHaveLength(25);
  });

  it('filters MRs by created_after and keeps the draft flag across a title edit', async () => {
    let now = 1_000_000;
    const s = await start({ now: () => now });
    s.act('publisher', { type: 'mr-open', sourceBranch: 'a', targetBranch: 'main', title: 'Old' });
    now += 60_000;
    const after = new Date(now - 1).toISOString();
    s.act('publisher', { type: 'mr-open', sourceBranch: 'a', targetBranch: 'main', title: 'New' });
    const list = await body<Array<{ title: string }>>(
      call(s, `/api/v4/projects/101/merge_requests?source_branch=a&created_after=${after}`),
    );
    expect(list.map((m: { title: string }) => m.title)).toEqual(['New']);
    const put = await call(s, '/api/v4/projects/101/merge_requests/2', {
      method: 'PUT',
      body: { title: 'Draft: Newer', description: 'x' },
    });
    expect(await put.json()).toMatchObject({ draft: true, description: 'x' });
  });

  it('serves the GitHub REST pulls subset and GraphQL review threads', async () => {
    const s = await start({ scenario: 'review-threads-unseen' });
    const pr = await call(s, '/api/v3/repos/acme/app/pulls', {
      header: 'github',
      method: 'POST',
      body: { head: 'feat', base: 'main', title: 'T', body: 'B', draft: false },
    });
    expect(await pr.json()).toMatchObject({
      number: 1,
      head: { ref: 'feat' },
      user: { login: 'publisher' },
    });
    const byHead = await (
      await call(s, '/repos/acme/app/pulls?head=acme:feat&state=all', { header: 'github' })
    ).json();
    expect(byHead).toHaveLength(1);
    const q = { owner: 'acme', name: 'app', number: 1 };
    const threads = await body<{
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{ id: string; comments: { nodes: { body: string }[] } }>;
            };
          };
        };
      };
    }>(
      call(s, '/api/graphql', {
        header: 'github',
        method: 'POST',
        body: { query: 'query { reviewThreads }', variables: q },
      }),
    );
    const nodes = threads.data.repository.pullRequest.reviewThreads.nodes;
    expect(
      nodes.map((n: { comments: { nodes: { body: string }[] } }) => n.comments.nodes[0]!.body),
    ).toEqual([...REVIEW_THREAD_BODIES]);
    const reply = await body<{ data: { addPullRequestReviewThreadReply: { comment: unknown } } }>(
      call(s, '/graphql', {
        header: 'github',
        method: 'POST',
        body: {
          query: 'mutation { addPullRequestReviewThreadReply }',
          variables: { threadId: nodes[0]!.id, body: 'done' },
        },
      }),
    );
    expect(reply.data.addPullRequestReviewThreadReply.comment).toMatchObject({ body: 'done' });
    const bad = await body<{ errors: unknown[] }>(
      call(s, '/graphql', {
        header: 'github',
        method: 'POST',
        body: { query: 'mutation { resolveReviewThread }', variables: { threadId: 'nope' } },
      }),
    );
    expect(bad.errors).toHaveLength(1);
  });

  it('P63 belt: every merge or approve path is 404, traced forbidden, state untouched', async () => {
    const s = await start();
    s.act('publisher', { type: 'mr-open', sourceBranch: 'a', targetBranch: 'main', title: 'T' });
    const attempts: [string, string, unknown?][] = [
      ['PUT', '/api/v4/projects/101/merge_requests/1/merge'],
      ['POST', '/api/v4/projects/101/merge_requests/1/approve'],
      ['GET', '/api/v4/projects/101/merge_requests/1/approvals'],
      ['PUT', '/api/v3/repos/acme/app/pulls/1/merge'],
      ['POST', '/repos/acme/app/pulls/1/reviews', { event: 'APPROVE' }],
      [
        'POST',
        '/graphql',
        { query: 'mutation { mergePullRequest(input:{}) { clientMutationId } }' },
      ],
      [
        'POST',
        '/graphql',
        { query: 'mutation { addPullRequestReview(input:{event: APPROVE}) { x } }' },
      ],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(s, path, { method, body });
      expect(res.status, path).toBe(404);
    }
    expect(s.requests.filter((r) => r.forbidden)).toHaveLength(attempts.length);
    expect(s.state().mrs[0]!.state).toBe('open');
    // `merge_requests` — существительное, не звено слияния: обычный путь не задет поясом.
    expect((await call(s, '/api/v4/projects/101/merge_requests/1')).status).toBe(200);
    expect(s.requests.at(-1)!.forbidden).toBeUndefined();
  });

  it('faults: status, garbage, reset and stall; 401 for an unknown access value', async () => {
    const s = await start({ faults: [{ kind: 'status', status: 502, path: '/user$', times: 1 }] });
    expect((await call(s, '/api/v4/user')).status).toBe(502);
    expect((await call(s, '/api/v4/user')).status).toBe(200);
    s.fault({ kind: 'garbage', path: /\/projects\/101$/ });
    expect(await (await call(s, '/api/v4/projects/101')).text()).toMatch(/^<html>/);
    s.clearFaults();
    s.fault({ kind: 'reset', path: /\/user$/, times: 1 });
    await expect(call(s, '/api/v4/user')).rejects.toThrow();
    s.fault({ kind: 'stall', path: /\/user$/, times: 1 });
    const stalled = call(s, '/api/v4/user').catch((error: Error) => error);
    await new Promise((r) => setTimeout(r, 100));
    await s.stop();
    expect(await stalled).toBeInstanceOf(Error);
    stub = undefined;
    const t = await start();
    expect((await call(t, '/api/v4/user', { as: 'nobody' })).status).toBe(401);
    expect(t.requests.at(-1)).toMatchObject({ tokenId: null, status: 401 });
    const refused = await closedPortUrl();
    await expect(fetch(`${refused}/api/v4/user`)).rejects.toThrow();
  });

  it('trace names the account, never the access value; query access params are hidden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stub-forge-'));
    dirs.push(dir);
    const trace = join(dir, 'trace.jsonl');
    const s = await start({ trace });
    await call(s, '/api/v4/user');
    await fetch(`${s.url}/api/v4/user?private_token=${s.tokens.reviewer}`);
    const text = readFileSync(trace, 'utf8');
    for (const token of Object.values(s.tokens)) expect(text).not.toContain(token);
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      method: 'GET',
      path: '/api/v4/user',
      tokenId: 'publisher',
      status: 200,
    });
    expect(lines[1].path).toBe('/api/v4/user?private_token=<present>');
  });

  it('scenario mr-red-never-settles-green seeds infra red then green for the same head', async () => {
    const s = await start({ scenario: 'mr-red-never-settles-green' });
    s.act('publisher', {
      type: 'mr-open',
      sourceBranch: 'a',
      targetBranch: 'main',
      title: 'T',
      headSha: 'a'.repeat(40),
    });
    const pipelines = await body<Array<{ status: string; id: number }>>(
      call(s, `/api/v4/projects/101/pipelines?sha=${'a'.repeat(40)}`),
    );
    expect(pipelines.map((p: { status: string }) => p.status)).toEqual(['success', 'failed']);
    const red = pipelines[1]!.id;
    const jobs = await body<unknown[]>(call(s, `/api/v4/projects/101/pipelines/${red}/jobs`));
    expect(jobs[0]).toMatchObject({ status: 'failed', failure_reason: 'runner_system_failure' });
    const runs = await body<{ workflow_runs: Array<{ conclusion: string }> }>(
      call(s, `/repos/acme/app/actions/runs?head_sha=${'a'.repeat(40)}`, { header: 'github' }),
    );
    expect(runs.workflow_runs.map((r: { conclusion: string }) => r.conclusion)).toEqual([
      'success',
      'failure',
    ]);
  });

  it('event feeds: newest first, paged like each forge, GitLab day filter, GitHub 300 cap', async () => {
    let now = Date.parse('2026-01-01T12:00:00Z');
    const s = await start({ now: () => now });
    const head = 'b'.repeat(40);
    s.act('publisher', { type: 'mr-open', sourceBranch: 'feat', targetBranch: 'main', title: 'X' });
    s.act('publisher', { type: 'push', ref: 'feat', sha: head });
    s.act('reviewer', { type: 'approval', mrIid: 1 });
    expect(s.act('publisher', { type: 'mergeability', mrIid: 1, conflict: true })).toMatchObject({
      iid: 1,
      headSha: head,
      conflict: true,
      checking: false,
    });
    s.act('reviewer', { type: 'merge', mrIid: 1 });
    now += 2 * 86_400_000;
    s.act('publisher', { type: 'branch-delete', ref: 'feat' });
    expect(() => s.act('publisher', { type: 'bogus' } as never)).toThrow(/unknown act «bogus»/);

    const lab = await body<Array<{ action_name: string; push_data?: { action: string } }>>(
      call(s, '/api/v4/projects/101/events'),
    );
    expect(lab.map((e) => e.action_name)).toEqual([
      'deleted',
      'accepted',
      'approved',
      'pushed to',
      'opened',
    ]);
    expect(lab[0]!.push_data).toEqual({ ref: 'feat', ref_type: 'branch', action: 'removed' });
    // `after` — день: события того же дня и раньше не идут, позже — идут.
    const later = await body<Array<{ action_name: string }>>(
      call(s, '/api/v4/projects/101/events?after=2026-01-01'),
    );
    expect(later.map((e) => e.action_name)).toEqual(['deleted']);
    const second = await body<Array<{ action_name: string }>>(
      call(s, '/api/v4/projects/101/events?per_page=2&page=2'),
    );
    expect(second.map((e) => e.action_name)).toEqual(['approved', 'pushed to']);

    const hub = await body<Array<{ type: string; payload: Record<string, unknown> }>>(
      call(s, '/repos/acme/app/events', { header: 'github' }),
    );
    expect(hub.map((e) => e.type)).toEqual([
      'DeleteEvent',
      'PullRequestEvent',
      'PullRequestReviewEvent',
      'PushEvent',
      'PullRequestEvent',
    ]);
    expect(hub[1]!.payload).toMatchObject({ action: 'closed', pull_request: { merged: true } });
    expect(hub[3]!.payload).toEqual({ ref: 'refs/heads/feat' });

    for (let i = 0; i < 330; i++) s.act('publisher', { type: 'push', ref: `b${i}`, sha: head });
    const gitlabPage = await body<unknown[]>(call(s, '/api/v4/projects/101/events'));
    expect(gitlabPage).toHaveLength(20);
    const capped = await body<unknown[]>(call(s, '/api/v4/projects/101/events?per_page=500'));
    expect(capped).toHaveLength(100);
    const fallback = await body<unknown[]>(
      call(s, '/repos/acme/app/events?per_page=0', { header: 'github' }),
    );
    expect(fallback).toHaveLength(30);
    const third = await body<Array<{ id: string }>>(
      call(s, '/repos/acme/app/events?per_page=100&page=3', { header: 'github' }),
    );
    expect(third).toHaveLength(100);
    const past = await call(s, '/repos/acme/app/events?per_page=100&page=4', { header: 'github' });
    expect(past.status).toBe(422);
    expect(await past.json()).toEqual({ message: 'pagination is limited for this resource' });
  });

  it('refuses reserved panel ports and unknown options', async () => {
    await expect(startStubForge({ port: 5178 })).rejects.toThrow(/reserved/);
    await expect(startStubForge({ bogus: 1 } as never)).rejects.toThrow(/unknown option/);
    await expect(startStubForge({ scenario: 'nope' as never })).rejects.toThrow(/unknown scenario/);
  });
});
