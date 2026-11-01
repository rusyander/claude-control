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
    const list = await (
      await call(s, '/api/v4/projects/101/merge_requests?source_branch=feat&author_id=1')
    ).json();
    expect(list.map((m: { iid: number }) => m.iid)).toEqual([1]);
    const none = await (
      await call(s, '/api/v4/projects/101/merge_requests?source_branch=feat&author_id=2')
    ).json();
    expect(none).toEqual([]);
    s.act('reviewer', { type: 'note', mrIid: 1, body: 'why?' });
    const threads = await (
      await call(s, '/api/v4/projects/101/merge_requests/1/discussions')
    ).json();
    expect(threads).toHaveLength(1);
    const id = threads[0].id as string;
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
    expect((await resolved.json()).notes[1]).toMatchObject({ body: 'because', resolved: true });
    const types = s.state().events.map((e) => [e.type, e.authorId]);
    expect(types).toEqual([
      ['mr-open', 1],
      ['note', 2],
      ['note', 1],
    ]);
  });

  it('filters MRs by created_after and keeps the draft flag across a title edit', async () => {
    let now = 1_000_000;
    const s = await start({ now: () => now });
    s.act('publisher', { type: 'mr-open', sourceBranch: 'a', targetBranch: 'main', title: 'Old' });
    now += 60_000;
    const after = new Date(now - 1).toISOString();
    s.act('publisher', { type: 'mr-open', sourceBranch: 'a', targetBranch: 'main', title: 'New' });
    const list = await (
      await call(s, `/api/v4/projects/101/merge_requests?source_branch=a&created_after=${after}`)
    ).json();
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
    const threads = await (
      await call(s, '/api/graphql', {
        header: 'github',
        method: 'POST',
        body: { query: 'query { reviewThreads }', variables: q },
      })
    ).json();
    const nodes = threads.data.repository.pullRequest.reviewThreads.nodes;
    expect(
      nodes.map((n: { comments: { nodes: { body: string }[] } }) => n.comments.nodes[0]!.body),
    ).toEqual([...REVIEW_THREAD_BODIES]);
    const reply = await (
      await call(s, '/graphql', {
        header: 'github',
        method: 'POST',
        body: {
          query: 'mutation { addPullRequestReviewThreadReply }',
          variables: { threadId: nodes[0].id, body: 'done' },
        },
      })
    ).json();
    expect(reply.data.addPullRequestReviewThreadReply.comment).toMatchObject({ body: 'done' });
    const bad = await (
      await call(s, '/graphql', {
        header: 'github',
        method: 'POST',
        body: { query: 'mutation { resolveReviewThread }', variables: { threadId: 'nope' } },
      })
    ).json();
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
    const pipelines = await (
      await call(s, `/api/v4/projects/101/pipelines?sha=${'a'.repeat(40)}`)
    ).json();
    expect(pipelines.map((p: { status: string }) => p.status)).toEqual(['success', 'failed']);
    const red = pipelines[1].id;
    const jobs = await (await call(s, `/api/v4/projects/101/pipelines/${red}/jobs`)).json();
    expect(jobs[0]).toMatchObject({ status: 'failed', failure_reason: 'runner_system_failure' });
    const runs = await (
      await call(s, `/repos/acme/app/actions/runs?head_sha=${'a'.repeat(40)}`, { header: 'github' })
    ).json();
    expect(runs.workflow_runs.map((r: { conclusion: string }) => r.conclusion)).toEqual([
      'success',
      'failure',
    ]);
  });

  it('refuses reserved panel ports and unknown options', async () => {
    await expect(startStubForge({ port: 5178 })).rejects.toThrow(/reserved/);
    await expect(startStubForge({ bogus: 1 } as never)).rejects.toThrow(/unknown option/);
    await expect(startStubForge({ scenario: 'nope' as never })).rejects.toThrow(/unknown scenario/);
  });
});
