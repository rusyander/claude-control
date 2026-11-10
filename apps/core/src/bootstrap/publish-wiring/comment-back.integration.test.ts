import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { startStubTracker, type StubTracker } from '@agentdeck/stub-tracker';
import { afterEach, describe, expect, it } from 'vitest';
import { createForgePort } from '../../adapters/forge/index.ts';
import { createBoardStore } from '../../conductor/board/store.ts';
import type { StepCtx, UnitCtx } from '../../conductor/run/run.types.ts';
import { presetOf } from '../../conductor/scenario/index.ts';
import { CREATED, openFresh, SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createConfigPort } from '../core-config/port.ts';
import {
  guardStand,
  REAL_PUBLISH_TIMEOUT_MS,
  type GuardStand,
} from '../guard-wiring/__fixtures__/guard-stand.ts';
import { composed } from './__fixtures__/publish-stand.ts';
import { reconcileTask } from '../../conductor/reconcile.ts';
import { actionReaders } from '../action-readers.ts';
import { commentBackOf } from '../panel-trackers.ts';
import { createPublishWiring, type PublishWiring } from './index.ts';
import { outboxPort } from './outbox-port.ts';

/**
 * Комментарий назад в тикет (этап 12, I6, P166) на НАСТОЯЩЕМ пути публикации: попытка шага
 * публикации ядра (`onPublish`) пушит в голый «сервер» и открывает MR у заглушки форжа; задача
 * стартовала с записи доски из источника Jira; Jira панели — заглушка трекера на loopback, ключ —
 * в настоящем зашифрованном хранилище временного каталога панели; настройка ядра — запись человека
 * через порт настройки. Комментарий — только через outbox (`tracker-write`), не больше одного.
 */

const SCENARIO = { id: 'feature', version: 1 } as const;
const PUBLISH = presetOf(SCENARIO)!.steps.find((s) => s.kind === 'publish') as StepDef;
const TICKET = 'PROJ-2';

interface CommentStand {
  st: GuardStand;
  task: LiveTask;
  stub: StubForge;
  tracker: StubTracker;
  wiring: PublishWiring;
  u: UnitCtx;
  s: StepCtx;
  notes: string[];
  coreHome: string;
  appData: string;
  lines(kind: string): Record<string, unknown>[];
  comments(): number;
  posts(): number;
}

const open: CommentStand[] = [];
afterEach(async () => {
  for (const one of open.splice(0)) {
    one.task.close();
    await one.stub.stop();
    await one.tracker.stop();
    one.st.remove();
  }
});

async function stand(opts: {
  commentBack: boolean;
  trackerWrites?: 'ask' | 'auto';
  boardSource?: 'tracker' | 'manual';
}): Promise<CommentStand> {
  const unitId = newId();
  const branch = `agentdeck/${unitId.slice(0, 8)}`;
  const st = guardStand(branch);
  const stub = await startStubForge({ repo: st.bare });
  const tracker = await startStubTracker({ trace: join(st.root, 'tracker-trace.jsonl') });
  // Каталог панели: Jira включена на заглушку, ключ — настоящим `@agentdeck/keys`.
  const appData = join(st.root, 'panel');
  mkdirSync(appData, { recursive: true });
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        integrations: {
          jira: {
            enabled: true,
            baseUrl: tracker.url,
            email: 'agent@tracker.example.com',
            deployment: 'cloud',
          },
        },
      },
    }),
  );
  expect(setStoredKey(appData, integrationKeyId('jira'), tracker.tokens['agent']!)).toBe(true);
  // Настройка ядра — запись человека (`nonce+peer`) через порт, как `POST /v1/config`.
  const coreHome = join(st.root, 'core-home');
  mkdirSync(coreHome, { recursive: true });
  const config = createConfigPort({ layout: layoutOf(coreHome), note: () => undefined });
  const view = config.port.view();
  if (!('value' in view)) throw new Error(view.unknown);
  const doc = {
    ...view.value.doc,
    inbox: {
      sources: [
        {
          id: 'jira-main',
          system: 'jira',
          enabled: true,
          repos: { PROJ: st.main },
          jira: { labels: ['agentdeck'], assignedToMe: false },
        },
      ],
      commentBack: opts.commentBack,
    },
    ...(opts.trackerWrites
      ? {
          humanPoints: {
            actionClasses: [],
            pathGlobs: [],
            trackerWrites: opts.trackerWrites,
            forgeWrites: 'ask',
          },
        }
      : {}),
  };
  const wrote = await config.port.set(
    { cmdId: newId(), doc: doc as never, baseDigest: view.value.digest, proof: {} },
    'nonce+peer',
  );
  expect(wrote.status).toBe(200);
  config.dispose();
  // Запись доски, с которой задача стартовала.
  const entryId = newId();
  const kind = opts.boardSource ?? 'tracker';
  createBoardStore({ root: coreHome }).update(newId(), Date.now(), (file) => {
    file.entries.push({
      entryId,
      state: 'started',
      rank: 0,
      stop: 'mr',
      preset: 'bug-fix',
      source:
        kind === 'tracker'
          ? { kind: 'tracker', system: 'jira-main', key: TICKET, title: 'Login button' }
          : { kind: 'manual', title: 'Login button' },
      launch: { kind: 'fields', fields: { title: 'Login button', request: 'Fix it' } },
      createdAt: Date.now(),
    });
    return { ok: true };
  });
  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      title: 'Fix the login button',
      repos: [{ repoKey: 'r1', path: st.main, baseRef: 'main' }],
      scenario: SCENARIO,
      ciWait: false,
      boardEntry: { entryId, stop: 'mr', source: kind, proof: { kind: 'human', cmdId: newId() } },
    },
  });
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch, ownedPaths: [], ...SOLO_UNIT },
  });
  task.append({
    kind: 'resource.created',
    actor: 'core',
    unitId,
    data: {
      rid: newId(),
      kind: 'copy',
      owner: 'core',
      release: 'unit-end',
      ref: JSON.stringify({ worktree: st.copy, repo: st.main }),
    },
  });
  const port = createForgePort({
    project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: st.bare },
    token: stub.tokens['publisher']!,
    fetch: globalThis.fetch,
  });
  const env = {
    ...st.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const notes: string[] = [];
  const wiring = createPublishWiring(
    {
      registry: {
        live: (id: string) => (id === task.taskId ? task : undefined),
        liveTasks: () => [task],
      } as never,
      coreHome,
      scenariosDir: join(st.root, 'scenarios'),
      note: (event, data) => notes.push(`${event}: ${String(data.message ?? '')}`),
      panelAppData: appData,
    },
    { git: { env }, forgeFor: () => ({ port, credential: null }) },
  );
  const u: UnitCtx = { taskId: task.taskId, unitId, repoKey: 'r1', copyDir: st.copy };
  const s: StepCtx = { ...u, stepId: newId(), def: PUBLISH, round: 0, sessionId: null };
  const one: CommentStand = {
    st,
    task,
    stub,
    tracker,
    wiring,
    u,
    s,
    notes,
    coreHome,
    appData,
    lines: (k) =>
      readJournalLines(task.dir, task.taskId)
        .lines.filter((l) => l.kind === k)
        .map((l) => l.data as Record<string, unknown>),
    comments: () => tracker.state().issues.find((i) => i.key === TICKET)!.comments.length,
    posts: () =>
      tracker.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comment')).length,
  };
  open.push(one);
  return one;
}

async function publishTwice(one: CommentStand): Promise<void> {
  const compositionId = await composed(one as never);
  const got = await one.wiring.hooks.onPublish!(one.s, compositionId);
  expect(got).toEqual({ kind: 'published', mrIid: expect.any(Number) });
  // Второй круг публикации над тем же MR: комментария второй раз нет никогда.
  expect(await one.wiring.hooks.onPublish!(one.s, compositionId)).toEqual(got);
}

const trackerWrites = (one: CommentStand) =>
  one.lines('action.started').filter((d) => d.kind === 'tracker-write');

describe('comment back on MR open (I6, P166)', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('off (the default): the MR opens, the tracker sees no write at all', async () => {
    const one = await stand({ commentBack: false, trackerWrites: 'auto' });
    await publishTwice(one);
    expect(one.posts()).toBe(0);
    expect(one.comments()).toBe(0);
    expect(trackerWrites(one)).toEqual([]);
  });

  it('on with tracker writes auto: exactly one comment with the MR link, through the outbox, across rounds', async () => {
    const one = await stand({ commentBack: true, trackerWrites: 'auto' });
    await publishTwice(one);
    expect(one.comments()).toBe(1);
    expect(one.posts()).toBe(1);
    const mr = one.lines('publish.mr')[0]!;
    const issue = one.tracker.state().issues.find((i) => i.key === TICKET)!;
    expect(issue.comments[0]!.text).toContain(String(mr.url));
    expect(issue.comments[0]!.author).toBe('agent');
    const started = trackerWrites(one);
    expect(started).toEqual([expect.objectContaining({ kind: 'tracker-write', target: TICKET })]);
    // Намерение на диске раньше записи: `action.started` стоит до `action.done` того же действия.
    const all = readJournalLines(one.task.dir, one.task.taskId).lines;
    const data = (l: (typeof all)[number]) => l.data as Record<string, unknown>;
    const at = all.findIndex(
      (l) => l.kind === 'action.started' && data(l).kind === 'tracker-write',
    );
    const done = all.findIndex(
      (l) => l.kind === 'action.done' && data(l).actionId === started[0]!.actionId,
    );
    expect(at).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(at);
    // Значение доступа ушло только заголовком: в журнале его нет.
    const token = one.tracker.tokens['agent']!;
    expect(JSON.stringify(all)).not.toContain(token);
  });

  it('MR found by its branch after a lost create reply: still exactly one comment', async () => {
    const one = await stand({ commentBack: true, trackerWrites: 'auto' });
    const compositionId = await composed(one as never);
    // Ответ создания потерян: намерение `mr-create` есть, MR ядру не известен.
    one.stub.fault({ kind: 'reset', method: 'POST', path: '/merge_requests$', times: 1 });
    const first = await one.wiring.hooks.onPublish!(one.s, compositionId);
    expect(first).not.toMatchObject({ kind: 'published' });
    expect(one.posts()).toBe(0);
    // Форж всё же открыл MR на ветку единицы — следующий круг находит его чтением по ветке.
    const branch = one.task.state.units[one.u.unitId]!.branch;
    one.stub.act('publisher', {
      type: 'mr-open',
      sourceBranch: branch,
      targetBranch: 'main',
      title: 'T',
    });
    const got = await one.wiring.hooks.onPublish!(one.s, compositionId);
    expect(got).toEqual({ kind: 'published', mrIid: expect.any(Number) });
    expect(one.posts()).toBe(1);
    expect(one.comments()).toBe(1);
    expect(trackerWrites(one)).toHaveLength(1);
  });

  it('tracker writes ask (the floor default): the comment is held and named, one blocking point-9 ask, nothing written', async () => {
    const one = await stand({ commentBack: true });
    await publishTwice(one);
    expect(one.posts()).toBe(0);
    expect(trackerWrites(one)).toEqual([]);
    expect(one.notes.join('\n')).toContain(
      `comment to ${TICKET} held: tracker writes ask first (point 9)`,
    );
    // W2-D: вопрос пункта 9 уровня задачи, блокирующий (без умолчания), ровно один на два круга.
    expect(one.lines('human.asked')).toEqual([
      expect.objectContaining({
        point: 9,
        source: 'tracker-write',
        dedupe: `tracker-write:${TICKET}:${one.u.unitId}`,
        defaultAction: null,
      }),
    ]);
  });

  it('a task not from a tracker source gets no comment even with comment back on', async () => {
    const one = await stand({ commentBack: true, trackerWrites: 'auto', boardSource: 'manual' });
    await publishTwice(one);
    expect(one.posts()).toBe(0);
    expect(trackerWrites(one)).toEqual([]);
  });

  it('an unknown write outcome (connection reset) is never retried on the next round', async () => {
    const one = await stand({ commentBack: true, trackerWrites: 'auto' });
    one.tracker.fault({ kind: 'reset', method: 'POST', path: '/comment$' });
    await publishTwice(one);
    expect(one.posts()).toBe(1);
    expect(trackerWrites(one)).toHaveLength(1);
    expect(one.lines('action.failed')).toEqual([
      expect.objectContaining({ code: 'tracker-unknown' }),
    ]);
    expect(one.notes.join('\n')).toContain(`comment to ${TICKET} failed: tracker-unknown`);
  });

  it('a crash between intent and write (action.started, no outcome) never writes a second time', async () => {
    const one = await stand({ commentBack: true, trackerWrites: 'auto' });
    // Журнал, каким его оставляет крах: намерение записано, исхода нет.
    one.task.append({
      kind: 'action.started',
      actor: 'core',
      data: {
        actionId: newId(),
        kind: 'tracker-write',
        target: TICKET,
        idempotencyHint: `comment jira-main ${TICKET} mr 1`,
      },
    });
    await publishTwice(one);
    expect(one.posts()).toBe(0);
    expect(one.comments()).toBe(0);
    expect(trackerWrites(one)).toHaveLength(1);
  });

  it('a crash after the tracker took the comment, before the outcome reached the journal: the reconcile reader says unknown (never absent), no second comment (W2-D)', async () => {
    const one = await stand({ commentBack: true, trackerWrites: 'auto' });
    // Запись дошла до трекера, ядро умерло до `action.done`: намерение на диске, комментарий в тикете.
    const actionId = newId();
    one.task.append({
      kind: 'action.started',
      actor: 'core',
      data: {
        actionId,
        kind: 'tracker-write',
        target: TICKET,
        idempotencyHint: `comment jira-main ${TICKET} mr 1`,
      },
    });
    const port = commentBackOf({ coreHome: one.coreHome, panelAppData: one.appData })(
      one.task,
      outboxPort(one.task),
    );
    const got = await port.target();
    if (!('target' in got)) throw new Error(got.skip);
    expect(await got.target.post('Merge request opened: before the crash')).toEqual({
      value: true,
    });
    expect(one.comments()).toBe(1);
    // Сверка при загрузке: читатель `tracker.write-by-hash` — «неизвестно», не «не было».
    const decisions = await reconcileTask(one.task, actionReaders(), Date, new Map());
    expect(decisions).toEqual([
      expect.objectContaining({ actionId, readClass: 'tracker.write-by-hash', fact: 'unknown' }),
    ]);
    expect(one.task.state.actions[actionId]?.status).toBe('started');
    await publishTwice(one);
    expect(one.posts()).toBe(1);
    expect(one.comments()).toBe(1);
    expect(trackerWrites(one)).toHaveLength(1);
  });
});
