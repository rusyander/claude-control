import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardEntry, BoardReply } from '@agentdeck/contracts/core/board';
import {
  BOARD_DEFAULTS,
  type BoardSection,
  type TelegramSection,
} from '@agentdeck/contracts/core/config';
import type { InboxItem } from '@agentdeck/contracts/core/inbox';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startStubTracker, type StubTracker } from '@agentdeck/stub-tracker';
import { afterEach, describe, expect, it } from 'vitest';
import { startStand, TOKENS, type Stand } from '../../api/__fixtures__/api-harness.ts';
import type { AllocatorWiring } from '../../bootstrap/allocator-wiring/index.ts';
import { createBoardWiring, type BoardWiring } from '../../bootstrap/board-wiring.ts';
import { createConfigPort, type CoreConfigWiring } from '../../bootstrap/core-config/port.ts';
import type { BootEconomy } from '../../bootstrap/economy-wiring/boot-economy.ts';
import { createInboxWiring, type InboxWiring } from '../../bootstrap/inbox-wiring.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { gitRepo, testEnv } from '../split/__fixtures__/split-stand.ts';

/**
 * Входящие через настоящий API ядра (этап 12, I3; P167, P183): Fastify, суд полномочий и число
 * страницы; настоящая доска (хранилище, запускатель, оценка); настоящая настройка ядра (записи
 * человека через порт); Jira панели — заглушка трекера, ключ — настоящим `@agentdeck/keys`.
 * Подменены только пробы дорог оценки (`testEnv`) — внешние CLI.
 */

interface InboxStand {
  s: Stand;
  tracker: StubTracker;
  board: BoardWiring;
  inbox: InboxWiring;
  config: CoreConfigWiring;
  /** Локальный git-репозиторий стенда (тот же, что в `repos` источника Jira). */
  repo: string;
  setConfig(o: {
    autoQueue: boolean;
    board?: Partial<BoardSection>;
    telegram?: TelegramSection;
  }): Promise<string>;
  post(body: Record<string, unknown>, proof?: boolean): Promise<{ status: number; body: never }>;
  read(): Promise<BoardReply>;
  settle(): Promise<void>;
  close(): Promise<void>;
}

const stands: InboxStand[] = [];
afterEach(async () => {
  for (const one of stands.splice(0)) await one.close();
});

const SEED = [
  {
    key: 'PROJ-2',
    summary: 'Login button does nothing',
    type: 'Bug',
    labels: ['agentdeck'],
    assignee: 'agent',
  },
  { key: 'PROJ-3', summary: 'Session storage', type: 'Task', assignee: 'owner' },
  { key: 'PROJ-5', summary: 'Export as CSV', type: 'Story', assignee: 'owner' },
];

async function stand(): Promise<InboxStand> {
  const root = mkdtempSync(join(tmpdir(), 'core-inbox-api-'));
  const tracker = await startStubTracker({ issues: SEED });
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
  setStoredKey(appData, integrationKeyId('jira'), tracker.tokens['agent']!);
  const cell: { board?: BoardWiring; inbox?: InboxWiring } = {};
  const s = await startStand(undefined, {
    board: () => cell.board?.port(),
    inbox: () => cell.inbox?.port(),
  });
  const repo = gitRepo(root, 'app');
  const config = createConfigPort({ layout: s.layout, note: () => undefined });
  const setConfig: InboxStand['setConfig'] = async (o) => {
    const view = config.port.view();
    if (!('value' in view)) throw new Error(view.unknown);
    const doc = {
      ...view.value.doc,
      board: { ...BOARD_DEFAULTS, ...view.value.doc.board, ...o.board },
      ...(o.telegram ? { telegram: o.telegram } : {}),
      inbox: {
        sources: [
          {
            id: 'jira-main',
            system: 'jira',
            enabled: true,
            repos: { PROJ: repo },
            jira: { labels: ['agentdeck'], assignedToMe: false },
            autoQueue: o.autoQueue,
          },
        ],
      },
    };
    const cmdId = newId();
    const got = await config.port.set(
      { cmdId, doc: doc as never, baseDigest: view.value.digest, proof: {} },
      'nonce+peer',
    );
    if (got.status !== 200) throw new Error(`config write ${got.status}`);
    return cmdId;
  };
  const env = testEnv(join(root, 'scenarios'));
  s.setSplit(env);
  const board = createBoardWiring({
    registry: s.registry,
    layout: s.layout,
    note: () => undefined,
    split: () => env,
    reviewLink: () => undefined,
    config: config.port,
    economy: { ladders: {} } as unknown as BootEconomy,
    windows: s.windows,
    allocator: {} as AllocatorWiring,
    now: Date.now,
  });
  cell.board = board;
  board.start();
  const inbox = createInboxWiring({
    layout: s.layout,
    note: () => undefined,
    config: config.port,
    board: () => board.port(),
    panelAppData: appData,
    now: Date.now,
  });
  cell.inbox = inbox;
  const one: InboxStand = {
    s,
    tracker,
    board,
    inbox,
    config,
    repo,
    setConfig,
    async post(body, proof = true) {
      const res = await fetch(`${s.url}/v1/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.core}` },
        body: JSON.stringify({ ...body, proof: proof ? await s.nonce() : {} }),
      });
      return { status: res.status, body: (await res.json()) as never };
    },
    async read() {
      const res = await s.get('/v1/board');
      return (await res.json()) as BoardReply;
    },
    async settle() {
      await board.idle();
      await board.idle();
    },
    async close() {
      await inbox.stop();
      await board.stop();
      config.dispose();
      await s.close();
      await tracker.stop();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  stands.push(one);
  return one;
}

const byKey = (reply: BoardReply, key: string): BoardEntry => {
  const found = reply.entries.find((e) => e.source.key === key);
  if (!found) throw new Error(`no entry ${key}`);
  return found;
};

describe('inbox API and auto-queue on the real board (I3)', { timeout: 120_000 }, () => {
  it('JQL search writes nothing; multi-select creates N inbox entries in one call, never a task (P167)', async () => {
    const one = await stand();
    await one.setConfig({ autoQueue: true });
    const tasksBefore = one.s.registry.liveTasks().length;
    const res = await one.s.get(
      `/v1/inbox/search?sourceId=jira-main&q=${encodeURIComponent('project = PROJ')}`,
    );
    expect(res.status).toBe(200);
    const found = (await res.json()) as { items: InboxItem[]; truncated: boolean };
    expect(found.items.map((i) => i.key).sort()).toEqual(['PROJ-2', 'PROJ-3', 'PROJ-5']);
    expect((await one.read()).entries).toEqual([]);
    // Сеанс модели поиском не ходит: запрос ушёл бы в трекер с учёткой человека (P165, P167).
    const asked = one.tracker.requests.length;
    const bySession = await fetch(
      `${one.s.url}/v1/inbox/search?sourceId=jira-main&q=${encodeURIComponent('project = PROJ')}`,
      { headers: { authorization: `Bearer ${TOKENS.session}` } },
    );
    expect(bySession.status).toBe(403);
    expect(((await bySession.json()) as { code: string }).code).toBe('forged-authority');
    expect(one.tracker.requests.length).toBe(asked);
    const picked = found.items.filter((i) => i.key !== 'PROJ-3');
    const cmdId = newId();
    const body = { cmdId, create: { source: 'search', sourceId: 'jira-main', items: picked } };
    // Без доказательства человека — отказ суда, ни одной записи.
    const refused = await one.post(body, false);
    expect(refused.status).toBe(403);
    expect((await one.read()).entries).toEqual([]);
    const made = await one.post(body);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ existing: [], replayed: false });
    expect((made.body as { created: string[] }).created).toHaveLength(2);
    await one.settle();
    const reply = await one.read();
    expect(reply.entries.map((e) => e.state)).toEqual(['inbox', 'inbox']);
    expect(byKey(reply, 'PROJ-2').preset).toBe('bug-fix');
    expect(byKey(reply, 'PROJ-5').preset).toBe('tracker-ticket');
    expect(one.s.registry.liveTasks().length).toBe(tasksBefore);
    // Повтор того же `cmdId` — ответ первого раза, второй записи нет.
    const again = await one.post(body);
    expect(again.body).toMatchObject({
      created: (made.body as { created: string[] }).created,
      replayed: true,
    });
    expect((await one.read()).entries).toHaveLength(2);
  });

  it('auto-queue on → queued with the config proof; switched off → back to inbox with the reason; on again → started (P183)', async () => {
    const one = await stand();
    const enabling = await one.setConfig({ autoQueue: true, board: { paused: true } });
    await one.inbox.poll();
    const queued = byKey(await one.read(), 'PROJ-2');
    expect(queued).toMatchObject({ state: 'queued', proof: { kind: 'config', cmdId: enabling } });
    // Запись настройки, включившая автоочередь, заменена выключающей: старт по старому слову — нет.
    await one.setConfig({ autoQueue: false, board: { paused: false } });
    await one.settle();
    const back = byKey(await one.read(), 'PROJ-2');
    expect(back.state).toBe('inbox');
    expect(back.reason).toBe('auto-queue is off for tracker sources now (source jira-main)');
    expect(back.proof).toBeUndefined();
    expect(back.taskId).toBeUndefined();
    // Снова включили: новый тикет встаёт в очередь с новым доказательством и стартует.
    const second = await one.setConfig({ autoQueue: true, board: { paused: false } });
    one.tracker.upsertIssue({
      key: 'PROJ-6',
      summary: 'Add a logout link',
      type: 'Story',
      labels: ['agentdeck'],
    });
    await one.inbox.poll();
    await one.settle();
    const reply = await one.read();
    const fresh = byKey(reply, 'PROJ-6');
    expect(fresh.proof).toEqual({ kind: 'config', cmdId: second });
    expect(fresh.state).toBe('started');
    expect(fresh.taskId).toEqual(expect.any(String));
    // Вернувшаяся во «Входящие» запись сама в очередь не встаёт.
    expect(byKey(reply, 'PROJ-2').state).toBe('inbox');
  });

  it('a manual telegram entry lands in inbox even with auto-queue on (D29)', async () => {
    const one = await stand();
    await one.setConfig({ autoQueue: true });
    const made = await one.post({
      cmdId: newId(),
      create: {
        source: 'telegram',
        text: 'Fix the flaky login test\nit fails on CI',
        key: 'tg:42:7',
      },
    });
    expect(made.status).toBe(200);
    await one.settle();
    const entry = byKey(await one.read(), 'tg:42:7');
    expect(entry).toMatchObject({
      state: 'inbox',
      preset: 'feature',
      source: { kind: 'telegram', title: 'Fix the flaky login test' },
    });
    expect(entry.proof).toBeUndefined();
  });

  it('W2-D: a telegram entry carries the human telegram.repos and starts on a human work move; without repos it has none', async () => {
    const one = await stand();
    const { repo } = one;
    await one.setConfig({
      autoQueue: false,
      telegram: { owner: null, repos: [{ path: repo, baseRef: null }] },
    });
    const made = await one.post({
      cmdId: newId(),
      create: { source: 'telegram', text: 'Add a logout link', key: 'tg:42:8' },
    });
    expect(made.status).toBe(200);
    await one.settle();
    const entry = byKey(await one.read(), 'tg:42:8');
    expect(entry.launch).toEqual({
      kind: 'fields',
      fields: {
        title: 'Add a logout link',
        request: 'Add a logout link',
        repos: [{ path: repo, baseRef: null }],
      },
    });
    const res = await fetch(`${one.s.url}/v1/board/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.core}` },
      body: JSON.stringify({
        cmdId: newId(),
        entryId: entry.entryId,
        to: 'work',
        proof: await one.s.nonce(),
      }),
    });
    expect(res.status).toBe(200);
    await one.settle();
    const started = byKey(await one.read(), 'tg:42:8');
    expect(started.state).toBe('started');
    expect(started.taskId).toEqual(expect.any(String));
    // Без `telegram.repos` — запись без репозитория (его выберут на доске).
    await one.setConfig({ autoQueue: false, telegram: { owner: null } });
    await one.post({
      cmdId: newId(),
      create: { source: 'telegram', text: 'Second idea', key: 'tg:42:9' },
    });
    await one.settle();
    const bare = byKey(await one.read(), 'tg:42:9');
    expect(bare.launch).toEqual({
      kind: 'fields',
      fields: { title: 'Second idea', request: 'Second idea' },
    });
  });

  it('W2-D: a Bug ticket and a ticket switched to bug-fix start on a work move — only the lead intake reads the snapshot (P164)', async () => {
    const one = await stand();
    await one.setConfig({ autoQueue: false, board: { paused: false } });
    one.tracker.upsertIssue({
      key: 'PROJ-7',
      summary: 'Reset email is not sent',
      type: 'Story',
      labels: ['agentdeck'],
    });
    await one.inbox.poll();
    await one.settle();
    const polled = await one.read();
    expect(byKey(polled, 'PROJ-2').preset).toBe('bug-fix');
    expect(byKey(polled, 'PROJ-7').preset).toBe('tracker-ticket');
    const move = (body: Record<string, unknown>) =>
      one.s.nonce().then((proof) =>
        fetch(`${one.s.url}/v1/board/move`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.core}` },
          body: JSON.stringify({ cmdId: newId(), ...body, proof }),
        }),
      );
    const switched = await move({
      entryId: byKey(polled, 'PROJ-7').entryId,
      to: 'set-preset',
      preset: 'bug-fix',
    });
    expect(switched.status).toBe(200);
    for (const key of ['PROJ-2', 'PROJ-7']) {
      const res = await move({ entryId: byKey(await one.read(), key).entryId, to: 'work' });
      expect(res.status).toBe(200);
      await one.settle();
    }
    const after = await one.read();
    for (const key of ['PROJ-2', 'PROJ-7']) {
      const entry = byKey(after, key);
      expect({ key, state: entry.state, reason: entry.reason }).toEqual({
        key,
        state: 'started',
        reason: undefined,
      });
      expect(entry.taskId).toEqual(expect.any(String));
      // Снимок остаётся на записи: вернуть tracker-ticket до старта можно было бы и дальше.
      expect(entry.launch.kind === 'fields' && entry.launch.fields.source).toMatchObject({
        kind: 'tracker',
        key,
      });
    }
  });
});
