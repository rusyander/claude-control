import { BOARD_DEFAULTS, type ConfigView } from '@agentdeck/contracts/core/config';
import type { InboxSource } from '@agentdeck/contracts/core/inbox';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { startStubTracker, type StubTracker } from '@agentdeck/stub-tracker';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { gitlabIssue } from '../../adapters/forge/gitlab-map.ts';
import { createForgeInbox } from '../../adapters/forge/index.ts';
import { createJiraTracker } from '../../adapters/tracker/index.ts';
import { RETRY_AFTER_CAP_MS, retryAfterMsOf } from '../../adapters/tracker/transport.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { createBoardPort } from '../board/board.ts';
import { createBoardStore } from '../board/store.ts';
import { createInboxPoller } from './poller.ts';

/**
 * Входящие на настоящих переходниках (ревью волны 2): Jira — `createJiraTracker` над заглушкой
 * трекера по HTTP, GitLab — `createForgeInbox` над заглушкой форжа, доска — настоящее хранилище во
 * временной папке. Проверяет то, что видит человек: поиск ключом и словами, «только назначенные на
 * меня» выключено, один тикет из двух источников одного трекера — одна запись (P163).
 */

const stubs: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.stop();
});

const SEED = [
  { key: 'PROJ-1', summary: 'Export button', type: 'Story', labels: ['agent'], assignee: 'agent' },
  { key: 'PROJ-2', summary: 'Login page is blank', type: 'Bug', labels: ['agent', 'bug'] },
  { key: 'PROJ-3', summary: 'Session storage', type: 'Task' },
];

async function jiraWorld(): Promise<StubTracker> {
  const tracker = await startStubTracker({ issues: SEED });
  stubs.push(tracker);
  return tracker;
}

const configOf = (sources: InboxSource[]): { value: ConfigView } => ({
  value: { doc: { v: 1, inbox: { sources } }, digest: 'd', issues: [] } as unknown as ConfigView,
});

/** Запись файла доски; тест подменяет только диск (граница — файловая система). */
type BoardWrite = (path: string, text: string) => void;

function boardAt(write?: BoardWrite) {
  const store = createBoardStore({
    root: tempDir('inbox-review-board-'),
    ...(write ? { write } : {}),
  });
  const port = createBoardPort({
    store,
    tasks: { states: () => ({ states: [] }) } as never,
    section: () => BOARD_DEFAULTS,
    now: () => 1_000,
    onWrite: () => undefined,
  });
  return { store, port };
}

function pollerOver(
  sources: InboxSource[],
  over: { tracker?: StubTracker; forge?: StubForge; now?: () => number; write?: BoardWrite },
) {
  const { store, port } = boardAt(over.write);
  const t = over.tracker;
  const f = over.forge;
  const poller = createInboxPoller({
    config: () => configOf(sources),
    tracker: () =>
      t
        ? {
            port: createJiraTracker({
              site: { baseUrl: t.url, deployment: 'cloud' },
              email: t.users.find((u) => u.name === 'agent')!.email,
              token: t.tokens.agent!,
              fetch: fetch as never,
              timeoutMs: 5_000,
            }),
          }
        : { unknown: 'no jira' },
    forgeInbox: () =>
      f
        ? {
            port: createForgeInbox({
              kind: 'gitlab',
              baseUrl: f.url,
              token: f.tokens.publisher!,
              timeoutMs: 5_000,
            }),
          }
        : { unknown: 'no forge' },
    board: () => port,
    autoQueueCmd: () => null,
    now: over.now ?? (() => 1_000),
    note: () => undefined,
  });
  return { store, poller };
}

const JIRA: Extract<InboxSource, { system: 'jira' }> = {
  id: 'jira-main',
  system: 'jira',
  enabled: true,
  repos: { PROJ: 'C:/repos/app' },
  jira: { labels: ['agent'], assignedToMe: false },
};

describe('inbox on the real adapters (wave 2 review)', { timeout: 60_000 }, () => {
  it('Jira search by a ticket key and by words finds the ticket, JQL still works', async () => {
    const tracker = await jiraWorld();
    const { poller } = pollerOver([JIRA], { tracker });
    const byKey = await poller.port.search({ sourceId: 'jira-main', q: 'PROJ-2' });
    expect(byKey).toMatchObject({ ok: true, reply: { items: [{ key: 'PROJ-2' }] } });
    expect(byKey.ok && byKey.reply.problem).toBeFalsy();
    const byWords = await poller.port.search({ sourceId: 'jira-main', q: 'Session storage' });
    expect(byWords.ok && byWords.reply.items.map((i) => i.key)).toEqual(['PROJ-3']);
    const byJql = await poller.port.search({ sourceId: 'jira-main', q: 'labels = "bug"' });
    expect(byJql.ok && byJql.reply.items.map((i) => i.key)).toEqual(['PROJ-2']);
    // Ключ уходит строкой JQL `key = "…"`, а не голым словом (голое — 400 у трекера).
    expect(tracker.requests.map((r) => r.jql).filter(Boolean)).toContain('key = "PROJ-2"');
  });

  it('GitLab search matches the ticket key as well as the title', async () => {
    const forge = await startStubForge({});
    stubs.push(forge);
    const mr = forge.act('reviewer', {
      type: 'mr-open',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      title: 'Please review the parser',
      reviewers: ['publisher'],
    }) as { iid: number };
    const source: InboxSource = {
      id: 'gl',
      system: 'gitlab',
      enabled: true,
      repos: {},
      gitlab: {
        issues: { labels: [], assignedToMe: false },
        reviewerMrs: true,
        ownMrsWithThreads: false,
      },
    };
    const { poller } = pollerOver([source], { forge });
    const all = await poller.port.search({ sourceId: 'gl' });
    const key = all.ok ? all.reply.items[0]!.key : '';
    expect(key).toMatch(new RegExp(`!${mr.iid}$`));
    const found = await poller.port.search({ sourceId: 'gl', q: `!${mr.iid}` });
    expect(found.ok && found.reply.items.map((i) => i.key)).toEqual([key]);
  });

  it('GitLab issues by label with «only assigned to me» off read labelled issues of anyone', async () => {
    const forge = await startStubForge({});
    stubs.push(forge);
    forge.act('reviewer', {
      type: 'issue-open',
      title: 'Docs page is empty',
      body: 'docs/index.md renders nothing',
      labels: ['docs'],
      assignees: ['reviewer'],
    });
    forge.act('reviewer', {
      type: 'issue-open',
      title: 'Mine with the label',
      body: '',
      labels: ['docs'],
      assignees: ['publisher'],
    });
    const source = (assignedToMe: boolean): InboxSource => ({
      id: 'gl',
      system: 'gitlab',
      enabled: true,
      repos: {},
      gitlab: {
        issues: { labels: ['docs'], assignedToMe },
        reviewerMrs: false,
        ownMrsWithThreads: false,
      },
    });
    const anyone = pollerOver([source(false)], { forge });
    await anyone.poller.poll();
    expect(
      anyone.store
        .read()
        .entries.map((e) => e.source.title)
        .sort(),
    ).toEqual(['Docs page is empty', 'Mine with the label']);
    const mine = pollerOver([source(true)], { forge });
    await mine.poller.poll();
    expect(mine.store.read().entries.map((e) => e.source.title)).toEqual(['Mine with the label']);
  });

  it('one ticket read by two sources of the one panel Jira is one entry, a rejected one never returns (P163)', async () => {
    const tracker = await jiraWorld();
    const bugs: InboxSource = {
      id: 'jira-bugs',
      system: 'jira',
      enabled: true,
      repos: { PROJ: 'C:/repos/app' },
      jira: { labels: [], assignedToMe: false, jql: 'type = Bug' },
    };
    const { store, poller } = pollerOver([JIRA, bugs], { tracker });
    const reports = await poller.poll();
    expect(reports.map((r) => r.id)).toEqual(['jira-main', 'jira-bugs']);
    const keys = store.read().entries.map((e) => e.source.key);
    expect(keys.sort()).toEqual(['PROJ-1', 'PROJ-2']);
    // Источник переименовали: тот же тикет — та же запись, отклонённая не возвращается.
    store.update(null, 2_000, (file) => {
      for (const e of file.entries) e.state = 'rejected';
      return { ok: true };
    });
    const renamed = { ...JIRA, id: 'jira-renamed' };
    const again = pollerOver([renamed], { tracker });
    const file = store.read();
    again.store.update(null, 2_000, (f) => {
      f.entries.push(...file.entries);
      return { ok: true };
    });
    await again.poller.poll();
    expect(again.store.read().entries.map((e) => e.state)).toEqual(['rejected', 'rejected']);
  });

  it('a board write failing for one source leaves it unknown, the next source still writes in the same round', async () => {
    const tracker = await jiraWorld();
    const bugs: InboxSource = {
      id: 'jira-bugs',
      system: 'jira',
      enabled: true,
      repos: { PROJ: 'C:/repos/app' },
      jira: { labels: [], assignedToMe: false, jql: 'type = Bug' },
    };
    let failures = 1;
    const write: BoardWrite = (path, text) => {
      if (failures-- > 0) throw new Error('disk full');
      writeFileSync(path, text);
    };
    const { store, poller } = pollerOver([JIRA, bugs], { tracker, write });
    const reports = await poller.poll();
    expect(reports[0]).toMatchObject({
      id: 'jira-main',
      unknown: expect.stringMatching(/disk full/),
    });
    expect(reports[1]).toMatchObject({ id: 'jira-bugs', created: [expect.any(String)] });
    expect(store.read().entries.map((e) => e.source.key)).toEqual(['PROJ-2']);
    // Следующий круг дописывает то, что не записалось: источник не потерян.
    await poller.poll();
    expect(
      store
        .read()
        .entries.map((e) => e.source.key)
        .sort(),
    ).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('Jira labels and links coming back in another order do not mark the entry, a real edit does', async () => {
    const tracker = await startStubTracker({
      issues: [
        {
          key: 'PROJ-1',
          summary: 'Export button',
          type: 'Story',
          labels: ['agent', 'ui'],
          links: [
            { type: 'Blocks', key: 'PROJ-2', direction: 'outward' },
            { type: 'Relates', key: 'PROJ-3', direction: 'outward' },
          ],
        },
        { key: 'PROJ-2', summary: 'Login page is blank', type: 'Bug' },
        { key: 'PROJ-3', summary: 'Session storage', type: 'Task' },
      ],
    });
    stubs.push(tracker);
    const { poller } = pollerOver([JIRA], { tracker });
    const first = await poller.poll();
    expect(first[0]).toMatchObject({ created: [expect.any(String)] });
    tracker.upsertIssue({
      key: 'PROJ-1',
      labels: ['ui', 'agent'],
      links: [
        { type: 'Relates', key: 'PROJ-3', direction: 'outward' },
        { type: 'Blocks', key: 'PROJ-2', direction: 'outward' },
      ],
    });
    const reordered = await poller.poll();
    expect(reordered[0]).toMatchObject({ created: [], marked: [] });
    tracker.upsertIssue({ key: 'PROJ-1', summary: 'Export button, CSV too' });
    const edited = await poller.poll();
    expect(edited[0]).toMatchObject({ created: [], marked: [expect.any(String)] });
  });

  it('Jira 429 with Retry-After holds the source until then, the poll after it reads again', async () => {
    const tracker = await jiraWorld();
    tracker.fault({ kind: 'status', status: 429, retryAfter: 120, path: '/search', times: 1 });
    let t = 1_000;
    const { store, poller } = pollerOver([JIRA], { tracker, now: () => t });
    const searches = () => tracker.requests.filter((r) => r.path.includes('/search')).length;
    const limited = await poller.poll();
    expect(limited[0]).toMatchObject({ unknown: expect.stringMatching(/rate-limited/) });
    const asked = searches();
    t += 60_000;
    const held = await poller.poll();
    expect(held[0]).toMatchObject({ unknown: expect.stringMatching(/retry after/) });
    expect(searches()).toBe(asked);
    expect(store.read().entries).toEqual([]);
    t += 61_000;
    const again = await poller.poll();
    expect(again[0]).toMatchObject({ created: [expect.any(String), expect.any(String)] });
    expect(searches()).toBeGreaterThan(asked);
  });

  it('Jira comment answered 429 waits Retry-After and writes exactly once; endless 429 is a refusal with no comment', async () => {
    const tracker = await jiraWorld();
    const slept: number[] = [];
    const port = (t: StubTracker) =>
      createJiraTracker({
        site: { baseUrl: t.url, deployment: 'cloud' },
        email: t.users.find((u) => u.name === 'agent')!.email,
        token: t.tokens.agent!,
        fetch: fetch as never,
        timeoutMs: 5_000,
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
    tracker.fault({
      kind: 'status',
      status: 429,
      retryAfter: 2,
      method: 'POST',
      path: 'comment',
      times: 1,
    });
    const once = await port(tracker).comment('PROJ-1', 'Merge request opened: x');
    expect(once).toEqual({ value: true });
    expect(slept).toEqual([2_000]);
    const comments = () => tracker.state().issues.find((i) => i.key === 'PROJ-1')!.comments;
    expect(comments()).toHaveLength(1);
    tracker.fault({ kind: 'status', status: 429, method: 'POST', path: 'comment' });
    slept.length = 0;
    const never = await port(tracker).comment('PROJ-1', 'Merge request opened: y');
    expect(never).toMatchObject({ refused: expect.stringMatching(/rate-limited/), status: 429 });
    expect(slept.length).toBe(2);
    expect(comments()).toHaveLength(1);
  });

  it('Retry-After reads seconds and HTTP dates, ignores garbage, is capped', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(retryAfterMsOf('120', now)).toBe(120_000);
    expect(retryAfterMsOf('Mon, 09 Nov 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMsOf('Mon, 09 Nov 2026 11:00:00 GMT', now)).toBe(0);
    expect(retryAfterMsOf('soon', now)).toBeUndefined();
    expect(retryAfterMsOf(null, now)).toBeUndefined();
    expect(retryAfterMsOf('999999', now)).toBe(RETRY_AFTER_CAP_MS);
  });

  it('GitLab issue digest does not depend on the order of its links', () => {
    const row = {
      iid: 7,
      title: 'Docs page is empty',
      web_url: 'https://forge.example.com/g/p/-/issues/7',
      labels: ['docs'],
      references: { full: 'g/p#7' },
    };
    const ab = gitlabIssue(row, ['g/p#1', 'g/p#2']);
    const ba = gitlabIssue(row, ['g/p#2', 'g/p#1']);
    expect(ab?.digest).toBe(ba?.digest);
    expect(gitlabIssue(row, ['g/p#1'])?.digest).not.toBe(ab?.digest);
  });
});
