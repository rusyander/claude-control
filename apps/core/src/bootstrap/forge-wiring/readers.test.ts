import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createForgePort,
  forgeActionKey,
  mrBodyHash,
  noteHash,
  type ForgeActionKey,
} from '../../adapters/forge/index.ts';
import type { OpenAction } from '../../conductor/reconcile.ts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { forgeActionReaders, FORGE_CLOCK_SKEW_MS } from './readers.ts';

/**
 * Читатели сверки публикации против заглушки форжа и настоящего голого репозитория: значение —
 * только свидетельство самого действия, `absent` — его не было, чужой сдвиг ветки и половина
 * действия (ответ без разрешения) — исключение, то есть `unknown`, и сверка спросит человека.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let bare: string;
let work: string;
let shaA: string;
let shaB: string;
let shaC: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-readers-'));
  bare = join(root, 'remote.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 'qa@tracker.example.com');
  git(work, 'config', 'user.name', 'qa');
  const commit = (m: string) => {
    git(work, 'commit', '-q', '--allow-empty', '-m', m);
    return git(work, 'rev-parse', 'HEAD');
  };
  shaA = commit('a');
  shaB = commit('b');
  shaC = commit('c');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let stub: StubForge | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

function action(key: ForgeActionKey, startedAt = Date.now()): OpenAction {
  const { target, idempotencyHint } = forgeActionKey(key);
  return { actionId: newId(), kind: key.kind, target, idempotencyHint, startedAt, startedSeq: 1 };
}

/** Читатель через `readFact` его класса — ровно так, как его зовёт `reconcileTask`. */
async function read(a: OpenAction, readers = forgeActionReaders()) {
  const classes = {
    push: 'push.remote-sha',
    'ref-delete': 'push.remote-sha',
    'mr-create': 'mr.by-source-branch',
    'mr-update': 'mr.by-source-branch',
    'thread-reply': 'thread.reply-by-hash',
    'mr-comment': 'thread.reply-by-hash',
    'tracker-write': 'tracker.write-by-hash',
  } as const;
  const kind = a.kind as keyof typeof classes;
  return readFact(classes[kind], readers[kind](a));
}

describe('push and ref-delete readers over a real bare remote (ls-remote)', () => {
  const ref = 'refs/heads/feat';
  const push = (sha: string, before: string | null) =>
    action({ kind: 'push', url: bare, ref, sha, before });

  it('absent branch → absent; branch at the pushed sha → value; at before → absent; third sha → unknown', async () => {
    expect(await read(push(shaB, shaA))).toEqual({ absent: true });
    git(work, 'push', '-q', bare, `${shaA}:${ref}`);
    expect(await read(push(shaB, shaA))).toEqual({ absent: true });
    git(work, 'push', '-q', '-f', bare, `${shaB}:${ref}`);
    expect(await read(push(shaB, shaA))).toEqual({ value: `${ref} at ${shaB}` });
    git(work, 'push', '-q', '-f', bare, `${shaC}:${ref}`);
    const moved = await read(push(shaB, shaA));
    expect(moved).toHaveProperty('unknown');
    expect((moved as { unknown: string }).unknown).toMatch(/remote moved by another writer/);
  });

  it('ref-delete: gone → absent (happened); still at its sha → value; moved → unknown', async () => {
    const del = (sha: string | null) => action({ kind: 'ref-delete', url: bare, ref, sha });
    git(work, 'push', '-q', '-f', bare, `${shaC}:${ref}`);
    expect(await read(del(shaC))).toEqual({ value: `${ref} at ${shaC}` });
    expect(await read(del(null))).toEqual({ value: `${ref} at ${shaC}` });
    expect(await read(del(shaA))).toHaveProperty('unknown');
    git(work, 'push', '-q', bare, `:${ref}`);
    expect(await read(del(shaC))).toEqual({ absent: true });
  });

  it('an unreadable remote is unknown, never absent', async () => {
    const got = await read(
      action({ kind: 'push', url: join(root, 'missing.git'), ref, sha: shaA, before: null }),
    );
    expect(got).toHaveProperty('unknown');
  });
});

describe.each(['gitlab', 'github'] as const)('forge readers on %s (stub forge)', (kind) => {
  async function setup(now?: () => number) {
    stub = await startStubForge({
      scenario: 'review-threads-unseen',
      ...(now ? { now } : {}),
    });
    const project = {
      kind,
      ref: 'acme/app',
      baseUrl: stub.url,
      pushUrl: `${stub.url}/acme/app.git`,
    };
    const port = (as: 'publisher' | 'reviewer') =>
      createForgePort({ project, token: stub!.tokens[as]!, fetch: globalThis.fetch });
    const readers = forgeActionReaders({ forgeFor: () => port('publisher') });
    return { url: project.pushUrl, port, readers };
  }

  it('mr-create: own MR after start → value; another account or an older MR → absent', async () => {
    let clock = Date.now();
    const { url, port, readers } = await setup(() => clock);
    const key = (b: string): ForgeActionKey => ({
      kind: 'mr-create',
      url,
      sourceBranch: b,
      bodyHash: mrBodyHash('t', 'b'),
    });
    const startedAt = clock;
    expect(await read(action(key('feat'), startedAt), readers)).toEqual({ absent: true });
    const created = await port('publisher').createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
    });
    if (!('value' in created)) throw new Error('create failed');
    expect(await read(action(key('feat'), startedAt), readers)).toEqual({
      value: `!${created.value.iid} ${created.value.url}`,
    });
    await port('reviewer').createMr({
      sourceBranch: 'other',
      targetBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
    });
    expect(await read(action(key('other'), startedAt), readers)).toEqual({ absent: true });
    clock += FORGE_CLOCK_SKEW_MS + 60_000;
    expect(await read(action(key('feat'), clock), readers)).toEqual({ absent: true });
  });

  it('mr-update: the title+body hash equal to the hint → value; the old body → absent', async () => {
    const { url, port, readers } = await setup();
    const created = await port('publisher').createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 't',
      body: 'old',
      draft: true,
    });
    if (!('value' in created)) throw new Error('create failed');
    const iid = created.value.iid;
    const upd = action({ kind: 'mr-update', url, iid, bodyHash: mrBodyHash('t', 'new') });
    expect(await read(upd, readers)).toEqual({ absent: true });
    await port('publisher').updateMr(iid, { body: 'new' });
    expect(await read(upd, readers)).toEqual({ value: `!${iid} ${mrBodyHash('t', 'new')}` });
    const missing = action({ kind: 'mr-update', url, iid: 999, bodyHash: mrBodyHash('t', 'x') });
    expect(await read(missing, readers)).toEqual({ absent: true });
  });

  it('thread-reply: own note with the hash → value; resolve owed but missing → unknown; reviewer note → absent', async () => {
    const { url, port, readers } = await setup();
    const created = await port('publisher').createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
    });
    if (!('value' in created)) throw new Error('create failed');
    const iid = created.value.iid;
    const threads = await port('publisher').threads(iid);
    if (!('value' in threads) || !threads.value[0]) throw new Error('scenario threads missing');
    const threadId = threads.value[0].id;
    const key = (body: string, resolve: boolean): ForgeActionKey => ({
      kind: 'thread-reply',
      url,
      iid,
      threadId,
      bodyHash: noteHash(body),
      resolve,
    });
    const startedAt = Date.now();
    await port('reviewer').reply(iid, threadId, 'fixed');
    expect(await read(action(key('fixed', false), startedAt), readers)).toEqual({ absent: true });
    const note = await port('publisher').reply(iid, threadId, 'done');
    if (!('value' in note)) throw new Error('reply failed');
    expect(await read(action(key('done', false), startedAt), readers)).toEqual({
      value: `!${iid} ${threadId} note ${note.value.id}`,
    });
    const half = await read(action(key('done', true), startedAt), readers);
    expect((half as { unknown: string }).unknown).toMatch(/not resolved/);
    await port('publisher').resolve(iid, threadId);
    expect(await read(action(key('done', true), startedAt), readers)).toHaveProperty('value');
  });

  it('mr-comment: own top-level note with the hash → value; reviewer note or another body → absent', async () => {
    const { url, port, readers } = await setup();
    const created = await port('reviewer').createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
    });
    if (!('value' in created)) throw new Error('create failed');
    const iid = created.value.iid;
    const body = '**Замечания ревью (1)**\n\n1. a.ts:1 — x';
    const key = (b: string): ForgeActionKey => ({
      kind: 'mr-comment',
      url,
      iid,
      bodyHash: noteHash(b),
    });
    const startedAt = Date.now();
    expect(await read(action(key(body), startedAt), readers)).toEqual({ absent: true });
    await port('reviewer').comment(iid, body);
    expect(await read(action(key(body), startedAt), readers)).toEqual({ absent: true });
    const note = await port('publisher').comment(iid, body);
    if (!('value' in note)) throw new Error(`comment failed: ${JSON.stringify(note)}`);
    expect(note.value.bodyHash).toBe(noteHash(body));
    expect(await read(action(key(body), startedAt), readers)).toEqual({
      value: `!${iid} note ${note.value.id}`,
    });
    expect(await read(action(key('other'), startedAt), readers)).toEqual({ absent: true });
  });
});

describe('tracker-write and unreadable keys', () => {
  it('tracker-write is unknown with the named reason, never absent', async () => {
    const a: OpenAction = {
      actionId: newId(),
      kind: 'tracker-write',
      target: 'PROJ-1',
      idempotencyHint: 'x',
      startedAt: 0,
      startedSeq: 1,
    };
    expect(await read(a)).toEqual({ unknown: 'no core tracker adapter' });
  });

  it('a target/hint not in the codec shape is unknown, never absent', async () => {
    // Прежняя форма цели (до кодека) — `origin/feature` и пустая подсказка.
    for (const kind of [
      'push',
      'ref-delete',
      'mr-create',
      'mr-update',
      'thread-reply',
      'mr-comment',
    ] as const) {
      const a: OpenAction = {
        actionId: newId(),
        kind,
        target: 'origin/feature',
        idempotencyHint: '',
        startedAt: 0,
        startedSeq: 1,
      };
      expect(await read(a)).toEqual({
        unknown: expect.stringMatching(/target\/hint unreadable/),
      });
    }
  });
});
