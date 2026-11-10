import type { ForgeInbox, ForgeInboxMr, ForgeIssue } from '@agentdeck/contracts/core/forge';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { createForgeInbox, INBOX_UNSUPPORTED } from './index.ts';

/**
 * Входящие GitLab (этап 12, I4) против заглушки форжа по HTTP: три списка, новые первыми,
 * потолок страниц — `unknown`, а не срезанный список; GitHub и «другой» — «не поддерживается»
 * с названной причиной и без единого запроса. Учётка входящих — `publisher`.
 */

let stub: StubForge | undefined;
let clock = 1_000;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

async function world(): Promise<StubForge> {
  clock = 1_000;
  stub = await startStubForge({ now: () => (clock += 1_000) });
  return stub;
}

function inbox(s: StubForge, extra: { maxPages?: number; token?: string | null } = {}): ForgeInbox {
  return createForgeInbox({
    kind: 'gitlab',
    baseUrl: s.url,
    token: extra.token === undefined ? s.tokens.publisher! : extra.token,
    timeoutMs: 5_000,
    ...(extra.maxPages === undefined ? {} : { maxPages: extra.maxPages }),
  });
}

function value<T>(fact: unknown): T {
  expect(fact).toHaveProperty('value');
  return (fact as { value: T }).value;
}

const apiCalls = (s: StubForge) => s.requests.filter((r) => !r.control);

function openMr(s: StubForge, as: string, branch: string, reviewers: string[] = []): number {
  const mr = s.act(as, {
    type: 'mr-open',
    sourceBranch: branch,
    targetBranch: 'main',
    title: `Draft: ${branch}`,
    labels: ['core'],
    reviewers,
  }) as { iid: number };
  return mr.iid;
}

function thread(s: StubForge, mrIid: number, resolved: boolean): void {
  const d = s.act('reviewer', { type: 'note', mrIid, body: 'please fix' }) as { id: string };
  if (resolved) s.act('reviewer', { type: 'resolve', mrIid, threadId: d.id });
}

describe('forge inbox (I4)', () => {
  describe('assignedIssues', () => {
    it('returns my open issues carrying every label, newest first, with links and epic', async () => {
      const s = await world();
      const issue = (title: string, extra: Record<string, unknown> = {}) =>
        (
          s.act('reviewer', {
            type: 'issue-open',
            title,
            body: `${title} body`,
            labels: ['core', 'ready'],
            assignees: ['publisher'],
            ...extra,
          }) as { iid: number }
        ).iid;
      const old = issue('old', { createdAt: 100 });
      const fresh = issue('fresh', { createdAt: 300, epic: { id: 9, iid: 4, groupId: 7 } });
      const middle = issue('middle', { createdAt: 200 });
      issue('theirs', { assignees: ['reviewer'] });
      issue('unlabelled', { labels: ['core'] });
      const closed = issue('closed');
      s.act('reviewer', { type: 'issue-update', iid: closed, state: 'closed' });
      s.act('reviewer', { type: 'issue-link', iid: old, targetIid: fresh });

      const got = value<ForgeIssue[]>(await inbox(s).assignedIssues({ labels: ['core', 'ready'] }));
      expect(got.map((i) => i.title)).toEqual(['fresh', 'middle', 'old']);
      const [f, m, o] = got as [ForgeIssue, ForgeIssue, ForgeIssue];
      expect(f).toMatchObject({
        iid: fresh,
        project: 'acme/app',
        url: `${s.url}/acme/app/-/issues/${fresh}`,
        labels: ['core', 'ready'],
        description: 'fresh body',
        epic: '7&4',
        links: [`acme/app#${old}`],
      });
      // Связь двусторонняя: старая видит свежую, средняя без связей.
      expect(o.links).toEqual([`acme/app#${fresh}`]);
      expect(m.links).toEqual([]);
      expect(m.epic).toBeUndefined();
      expect(f.digest).toMatch(/^[0-9a-f]{64}$/);
      const listCall = apiCalls(s).find((r) => r.path.startsWith('/api/v4/issues?'));
      expect(listCall?.path).toContain('scope=assigned_to_me');
      expect(listCall?.path).toContain('per_page=100');
      void middle;
    });

    it('changes the digest on a body edit and on a new link, not on a re-read', async () => {
      const s = await world();
      const one = s.act('reviewer', {
        type: 'issue-open',
        title: 'one',
        labels: ['core'],
        assignees: ['publisher'],
      }) as { iid: number };
      const two = s.act('reviewer', { type: 'issue-open', title: 'two' }) as { iid: number };
      const read = async () =>
        value<ForgeIssue[]>(await inbox(s).assignedIssues({ labels: ['core'] }))[0]!.digest;
      const first = await read();
      expect(await read()).toBe(first);
      s.act('reviewer', { type: 'issue-link', iid: one.iid, targetIid: two.iid });
      const linked = await read();
      expect(linked).not.toBe(first);
      s.act('reviewer', { type: 'issue-update', iid: one.iid, body: 'now with a path' });
      expect(await read()).not.toBe(linked);
    });

    it('page cap reached without the end of the list is unknown, not a cut list', async () => {
      const s = await world();
      for (let n = 0; n < 100; n += 1)
        s.act('reviewer', { type: 'issue-open', title: `i${n}`, assignees: ['publisher'] });
      const capped = await inbox(s, { maxPages: 1 }).assignedIssues({ labels: [] });
      expect(capped).toEqual({ unknown: expect.stringContaining('page cap') });
      // Две страницы: вторая короткая — конец списка, все 100 на месте.
      const whole = value<ForgeIssue[]>(
        await inbox(s, { maxPages: 2 }).assignedIssues({ labels: [] }),
      );
      expect(whole).toHaveLength(100);
    });

    it('a failed links read is unknown for the whole list', async () => {
      const s = await world();
      s.act('reviewer', { type: 'issue-open', title: 'one', assignees: ['publisher'] });
      s.fault({ kind: 'status', status: 502, path: '/links$' });
      expect(await inbox(s).assignedIssues({ labels: [] })).toEqual({
        unknown: expect.stringContaining('links'),
      });
    });
  });

  describe('reviewRequests', () => {
    it('returns only open MRs where I am a reviewer, newest first', async () => {
      const s = await world();
      const older = openMr(s, 'reviewer', 'feat/older', ['publisher']);
      openMr(s, 'reviewer', 'feat/not-mine');
      const newer = openMr(s, 'reviewer', 'feat/newer', ['publisher', 'reviewer']);
      const closed = openMr(s, 'reviewer', 'feat/closed', ['publisher']);
      s.act('reviewer', { type: 'mr-close', mrIid: closed });

      const got = value<ForgeInboxMr[]>(await inbox(s).reviewRequests());
      expect(got.map((m) => m.iid)).toEqual([newer, older]);
      expect(got[0]).toMatchObject({
        project: 'acme/app',
        title: 'feat/newer',
        labels: ['core'],
        openThreads: 0,
        url: `${s.url}/acme/app/-/merge_requests/${newer}`,
      });
    });

    it('a refused /user read is unknown', async () => {
      const s = await world();
      expect(await inbox(s, { token: 'not-a-known-token' }).reviewRequests()).toEqual({
        unknown: expect.stringContaining('credential refused'),
      });
      expect(await inbox(s, { token: null }).reviewRequests()).toEqual({
        unknown: expect.stringContaining('no gitlab credential'),
      });
    });
  });

  describe('ownMrsWithOpenThreads', () => {
    it('counts only resolvable unresolved threads of my own open MRs', async () => {
      const s = await world();
      const allResolved = openMr(s, 'publisher', 'feat/resolved');
      thread(s, allResolved, true);
      const mixed = openMr(s, 'publisher', 'feat/mixed');
      thread(s, mixed, true);
      thread(s, mixed, false);
      openMr(s, 'publisher', 'feat/quiet');
      const comment = openMr(s, 'publisher', 'feat/comment');
      s.act('reviewer', { type: 'note', mrIid: comment, body: 'fyi', resolvable: false });
      const theirs = openMr(s, 'reviewer', 'feat/theirs');
      thread(s, theirs, false);

      const got = value<ForgeInboxMr[]>(await inbox(s).ownMrsWithOpenThreads());
      expect(got).toEqual([expect.objectContaining({ iid: mixed, openThreads: 1 })]);
    });

    it('the digest moves when a thread is resolved', async () => {
      const s = await world();
      const mr = openMr(s, 'publisher', 'feat/two');
      thread(s, mr, false);
      const d = s.act('reviewer', { type: 'note', mrIid: mr, body: 'and this' }) as { id: string };
      const first = value<ForgeInboxMr[]>(await inbox(s).ownMrsWithOpenThreads());
      expect(first[0]?.openThreads).toBe(2);
      s.act('reviewer', { type: 'resolve', mrIid: mr, threadId: d.id });
      const second = value<ForgeInboxMr[]>(await inbox(s).ownMrsWithOpenThreads());
      expect(second[0]?.openThreads).toBe(1);
      expect(second[0]?.digest).not.toBe(first[0]?.digest);
    });

    it('a 5xx on discussions is unknown, not a list without that MR', async () => {
      const s = await world();
      thread(s, openMr(s, 'publisher', 'feat/x'), false);
      s.fault({ kind: 'status', status: 503, path: '/discussions$' });
      expect(await inbox(s).ownMrsWithOpenThreads()).toEqual({
        unknown: expect.stringContaining('http 503'),
      });
    });
  });

  describe('unsupported forges', () => {
    it.each(['github', 'generic'] as const)(
      '%s answers unsupported with the reason named and makes no call',
      async (kind) => {
        const s = await world();
        const port = createForgeInbox({ kind, baseUrl: s.url, token: s.tokens.publisher! });
        expect(port.kind).toBe(kind);
        const reason = { unsupported: INBOX_UNSUPPORTED[kind] };
        expect(await port.assignedIssues({ labels: [] })).toEqual(reason);
        expect(await port.reviewRequests()).toEqual(reason);
        expect(await port.ownMrsWithOpenThreads()).toEqual(reason);
        expect(reason.unsupported).toMatch(/not supported \(D16\)/);
        expect(apiCalls(s)).toEqual([]);
      },
    );
  });
});
