import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startStubTracker, type StubTracker } from '@agentdeck/stub-tracker';
import { afterEach, describe, expect, it } from 'vitest';
import { createBoardStore } from '../conductor/board/store.ts';
import { readHumanLedger } from '../conductor/human/ledger.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, SOLO_UNIT, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { layoutOf } from '../platform/core-home.ts';
import { commentBackOnce } from '../publisher/tracker-comment.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { createConfigPort } from './core-config/port.ts';
import { commentBackOf } from './panel-trackers.ts';
import { outboxPort } from './publish-wiring/outbox-port.ts';

/**
 * Придержанный комментарий назад в тикет (этап 12, P166, W2-D) на НАСТОЯЩЕЙ загрузке ядра: задача
 * прежнего ядра открыла MR при `trackerWrites: ask` — порт комментария поднял вопрос пункта 9 и
 * ничего не записал. Новая загрузка: ответ человека через `/v1/commands` (одноразовое число панели)
 * → команда `answer` → строка `human.answered` → отпускание записи (`comment-release.ts`, проводка
 * `boot-core.ts`) → Jira панели — заглушка трекера на loopback, ключ — настоящим `@agentdeck/keys`.
 * Подменён только внешний мир (трекер); CLI не запускается.
 */

const TICKET = 'PROJ-2';
const MR_URL = 'https://forge.example.com/acme/app/-/merge_requests/7';
const APPROVE = 'Allow the comment';

interface Seeded {
  home: string;
  appData: string;
  taskId: string;
  unitId: string;
  askId: string;
  tracker: StubTracker;
}

const cores: BootedCore[] = [];
const trackers: StubTracker[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop().catch(() => undefined);
  for (const t of trackers.splice(0)) await t.stop();
});

async function until(probe: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Дом ядра: настройка человека, запись доски из Jira, задача с MR и открытым вопросом пункта 9. */
async function seeded(extra?: (task: LiveTask, askId: string) => void): Promise<Seeded> {
  const root = tempDir('boot-comment-release-');
  const home = join(root, 'core');
  const tracker = await startStubTracker({ trace: join(root, 'tracker-trace.jsonl') });
  trackers.push(tracker);
  const appData = join(root, 'panel');
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
  mkdirSync(home, { recursive: true });
  const config = createConfigPort({ layout: layoutOf(home), note: () => undefined });
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
          repos: { PROJ: join(root, 'repo') },
          jira: { labels: ['agentdeck'], assignedToMe: false },
        },
      ],
      commentBack: true,
    },
  };
  const wrote = await config.port.set(
    { cmdId: newId(), doc: doc as never, baseDigest: view.value.digest, proof: {} },
    'nonce+peer',
  );
  expect(wrote.status).toBe(200);
  config.dispose();
  const entryId = newId();
  createBoardStore({ root: home }).update(newId(), Date.now(), (file) => {
    file.entries.push({
      entryId,
      state: 'started',
      rank: 0,
      stop: 'mr',
      preset: 'bug-fix',
      source: { kind: 'tracker', system: 'jira-main', key: TICKET, title: 'Login button' },
      launch: { kind: 'fields', fields: { title: 'Login button', request: 'Fix it' } },
      createdAt: Date.now(),
    });
    return { ok: true };
  });
  const registry = createTaskRegistry(layoutOf(home).tasks, deps());
  const task = await registry.create({
    ...CREATED,
    lang: 'en',
    boardEntry: {
      entryId,
      stop: 'mr',
      source: 'tracker',
      proof: { kind: 'human', cmdId: newId() },
    },
  });
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch: 'agentdeck/x', ownedPaths: [], ...SOLO_UNIT },
  });
  const mr = {
    unitId,
    forge: 'gitlab' as const,
    mrId: '70',
    mrIid: 7,
    url: MR_URL,
    sourceBranch: 'agentdeck/x',
    actionId: newId(),
  };
  // Настоящий подъём: порт комментария прежнего ядра при `trackerWrites: ask` (пол по умолчанию).
  const port = commentBackOf({ coreHome: home, panelAppData: appData })(
    task,
    outboxPort(task, { unitId }),
  );
  expect(await commentBackOnce(port, mr)).toMatchObject({ kind: 'held' });
  task.append({ kind: 'publish.mr', actor: 'core', unitId, data: mr });
  const ask = Object.values(readHumanLedger(task).asks).find((a) => a.source === 'tracker-write');
  if (!ask) throw new Error('point 9 ask not raised');
  extra?.(task, ask.askId);
  registry.closeAll();
  return { home, appData, taskId: task.taskId, unitId, askId: ask.askId, tracker };
}

async function boot(s: Seeded): Promise<BootedCore> {
  const core = await bootCore({
    home: s.home,
    build: 'comment-release-test',
    panelAppData: s.appData,
    loop: false,
  });
  cores.push(core);
  return core;
}

async function answer(core: BootedCore, s: Seeded, askId: string, text: string, token?: string) {
  const panel = readFileSync(core.layout.token, 'utf8').trim();
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, {
    headers: { authorization: `Bearer ${panel}` },
  });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/commands`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token ?? panel}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      kind: 'answer',
      target: { taskId: s.taskId },
      fields: { askId, answer: text },
      proof: { nonce, page },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const comments = (s: Seeded) =>
  s.tracker.state().issues.find((i) => i.key === TICKET)!.comments.length;
const posts = (s: Seeded) =>
  s.tracker.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comment')).length;
const writes = (task: LiveTask) =>
  Object.values(task.state.actions).filter((a) => a.kind === 'tracker-write');

describe('held tracker comment released by point 9 (W2-D, P166)', { timeout: 60_000 }, () => {
  it('the ask is task-level, blocking, point 9, panel-or-phone in its text; nothing is written while it is open', async () => {
    const s = await seeded();
    const core = await boot(s);
    const task = core.registry.live(s.taskId)!;
    const ask = readHumanLedger(task).asks[s.askId]!;
    expect(ask).toMatchObject({
      point: 9,
      source: 'tracker-write',
      blocking: true,
      stepId: null,
      defaultAction: null,
      dedupe: `tracker-write:${TICKET}:${s.unitId}`,
      options: [APPROVE, 'Do not write'],
    });
    expect(ask.question).toContain(MR_URL);
    expect(ask.question).toContain('Only an answer from the panel or the phone releases it');
    await new Promise((r) => setTimeout(r, 300));
    expect(posts(s)).toBe(0);
  });

  it('a session (agent) token cannot answer: 403 forged-authority, the ask stays open, nothing posted', async () => {
    const s = await seeded();
    const core = await boot(s);
    const session = core.sessionTokens.mint({ taskId: s.taskId, sessionId: newId() });
    const got = await answer(core, s, s.askId, APPROVE, session);
    expect(got.status).toBe(403);
    expect(JSON.stringify(got.body)).toContain('forged-authority');
    const task = core.registry.live(s.taskId)!;
    expect(task.state.asks[s.askId]?.state).toBe('open');
    await new Promise((r) => setTimeout(r, 300));
    expect(posts(s)).toBe(0);
  });

  it('the human approves from the panel: exactly one comment with the MR link, through the outbox', async () => {
    const s = await seeded();
    const core = await boot(s);
    const task = core.registry.live(s.taskId)!;
    const got = await answer(core, s, s.askId, APPROVE);
    expect(got.status).toBe(200);
    await until(() => writes(task).some((a) => a.status === 'done'), 'tracker-write done');
    expect(comments(s)).toBe(1);
    expect(posts(s)).toBe(1);
    const issue = s.tracker.state().issues.find((i) => i.key === TICKET)!;
    expect(issue.comments[0]!.text).toContain(MR_URL);
    expect(writes(task)).toEqual([expect.objectContaining({ target: TICKET, unitId: s.unitId })]);
  });

  it('a decline writes nothing, ever — a restart of the core does not ask again', async () => {
    const s = await seeded();
    const core = await boot(s);
    expect((await answer(core, s, s.askId, 'Do not write')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    await core.stop();
    cores.splice(cores.indexOf(core), 1);
    const again = await boot(s);
    const task = again.registry.live(s.taskId)!;
    await new Promise((r) => setTimeout(r, 300));
    expect(posts(s)).toBe(0);
    expect(writes(task)).toEqual([]);
    const tw = Object.values(readHumanLedger(task).asks).filter(
      (a) => a.source === 'tracker-write',
    );
    expect(tw).toHaveLength(1);
  });

  it('approved but nowhere to write (Jira turned off since): a failed tracker-write action names it, no post', async () => {
    const s = await seeded();
    // После подъёма вопроса Jira в панели выключили: писать некуда.
    writeFileSync(
      join(s.appData, 'state.json'),
      JSON.stringify({ settings: { integrations: { jira: { enabled: false } } } }),
    );
    const core = await boot(s);
    const task = core.registry.live(s.taskId)!;
    expect((await answer(core, s, s.askId, APPROVE)).status).toBe(200);
    await until(() => writes(task).length > 0, 'tracker-write recorded');
    expect(writes(task)).toEqual([
      expect.objectContaining({ target: TICKET, status: 'failed', code: 'comment-skipped' }),
    ]);
    expect(posts(s)).toBe(0);
  });

  it('an approval through Telegram never releases: the core asks again and posts nothing', async () => {
    const s = await seeded((task, askId) => {
      // Ответ Telegram, каким его пишет команда `answer` пира `telegram` (переход, затем ответ).
      task.append({
        kind: 'ask.transition',
        actor: 'human:telegram',
        data: { askId, event: 'answer', from: 'open', to: 'answered' },
      });
      task.append({
        kind: 'human.answered',
        actor: 'human:telegram',
        data: { askId, answer: APPROVE, channel: 'telegram' },
      });
    });
    const core = await boot(s);
    const task = core.registry.live(s.taskId)!;
    await until(
      () =>
        Object.values(task.state.asks).filter(
          (a) => a.source === 'tracker-write' && a.state === 'open',
        ).length === 1,
      'point 9 asked again',
    );
    expect(posts(s)).toBe(0);
    expect(writes(task)).toEqual([]);
  });
});
