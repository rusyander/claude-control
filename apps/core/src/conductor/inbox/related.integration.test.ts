import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardEntry, BoardReply } from '@agentdeck/contracts/core/board';
import { BOARD_DEFAULTS, type BoardSection } from '@agentdeck/contracts/core/config';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startStubTracker, type StubIssueSeed, type StubTracker } from '@agentdeck/stub-tracker';
import { afterEach, describe, expect, it } from 'vitest';
import { startStand, TOKENS, type Stand } from '../../api/__fixtures__/api-harness.ts';
import type { AllocatorWiring } from '../../bootstrap/allocator-wiring/index.ts';
import { createBoardWiring, type BoardWiring } from '../../bootstrap/board-wiring.ts';
import { createConfigPort } from '../../bootstrap/core-config/port.ts';
import type { BootEconomy } from '../../bootstrap/economy-wiring/boot-economy.ts';
import { createInboxWiring, type InboxWiring } from '../../bootstrap/inbox-wiring.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { gitRepo, testEnv } from '../split/__fixtures__/split-stand.ts';

/**
 * Подсказки «связано с …» и ход «Объединить» на настоящем ядре (этап 12, B11, D26, P186): Fastify,
 * суд полномочий и число страницы, настоящая доска (хранилище, запускатель, оценка), настоящий
 * опрос входящих; Jira панели — заглушка трекера с эпиками, связями и путями в описаниях. Подменены
 * только пробы дорог оценки (`testEnv`) — внешние CLI.
 */

interface RelatedStand {
  s: Stand;
  tracker: StubTracker;
  inbox: InboxWiring;
  setBoard(board: Partial<BoardSection>): Promise<void>;
  move(
    body: Record<string, unknown>,
    o?: { proof?: boolean; token?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  read(): Promise<BoardReply>;
  settle(): Promise<void>;
  close(): Promise<void>;
}

const stands: RelatedStand[] = [];
afterEach(async () => {
  for (const one of stands.splice(0)) await one.close();
});

const LABEL = ['agentdeck'];
/** Все тикеты — с общей меткой источника: метка сама по себе связью не считается. */
const SEED: StubIssueSeed[] = [
  {
    key: 'PROJ-10',
    summary: 'Login button does nothing',
    type: 'Story',
    labels: LABEL,
    parent: 'PROJ-1',
    description: 'The handler in src/auth/login.ts never fires.',
  },
  {
    key: 'PROJ-11',
    summary: 'Session lost after login',
    type: 'Story',
    labels: LABEL,
    parent: 'PROJ-1',
  },
  {
    key: 'PROJ-12',
    summary: 'Login form error text',
    type: 'Story',
    labels: LABEL,
    links: [{ type: 'Relates', key: 'PROJ-10', direction: 'outward' }],
  },
  {
    key: 'PROJ-13',
    summary: 'Export as CSV',
    type: 'Story',
    labels: LABEL,
    description: 'New button in src/list/export.ts',
  },
  {
    key: 'PROJ-14',
    summary: 'Login spinner',
    type: 'Story',
    labels: LABEL,
    description: 'Spinner while `./src/auth/login.ts` waits.',
  },
];

async function stand(): Promise<RelatedStand> {
  const root = mkdtempSync(join(tmpdir(), 'core-related-'));
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
  const setBoard = async (board: Partial<BoardSection>) => {
    const view = config.port.view();
    if (!('value' in view)) throw new Error(view.unknown);
    const doc = {
      ...view.value.doc,
      board: { ...BOARD_DEFAULTS, ...view.value.doc.board, ...board },
      inbox: {
        sources: [
          {
            id: 'jira-main',
            system: 'jira',
            enabled: true,
            repos: { PROJ: repo },
            jira: { labels: LABEL, assignedToMe: false },
            autoQueue: false,
          },
        ],
      },
    };
    const got = await config.port.set(
      { cmdId: newId(), doc: doc as never, baseDigest: view.value.digest, proof: {} },
      'nonce+peer',
    );
    if (got.status !== 200) throw new Error(`config write ${got.status}`);
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
  const one: RelatedStand = {
    s,
    tracker,
    inbox,
    setBoard,
    async move(body, o = {}) {
      const res = await fetch(`${s.url}/v1/board/move`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${o.token ?? TOKENS.core}`,
        },
        body: JSON.stringify({
          cmdId: newId(),
          ...body,
          proof: o.proof === false ? {} : await s.nonce(),
        }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async read() {
      return (await (await s.get('/v1/board')).json()) as BoardReply;
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
/** Подсказки карточки по названию (ядро даёт их в порядке колонки, а он — порядок опроса). */
const hintsOf = (reply: BoardReply, key: string) =>
  reply.cards
    .find((c) => c.entryId === byKey(reply, key).entryId)
    ?.related?.slice()
    .sort((a, b) => a.title.localeCompare(b.title));
const titleOf = (key: string) => SEED.find((i) => i.key === key)!.summary;

describe(
  'merge hints and the human merge move on the real core (B11, P186)',
  { timeout: 120_000 },
  () => {
    it('hints come from epic, links and shared paths only; a shared label alone gives none; nothing merges by itself', async () => {
      const one = await stand();
      await one.setBoard({ paused: true });
      await one.inbox.poll();
      await one.inbox.poll();
      const reply = await one.read();
      expect(reply.entries.map((e) => e.state)).toEqual(Array(5).fill('inbox'));
      expect(hintsOf(reply, 'PROJ-10')).toEqual([
        { entryId: byKey(reply, 'PROJ-12').entryId, title: titleOf('PROJ-12'), reasons: ['link'] },
        { entryId: byKey(reply, 'PROJ-14').entryId, title: titleOf('PROJ-14'), reasons: ['path'] },
        { entryId: byKey(reply, 'PROJ-11').entryId, title: titleOf('PROJ-11'), reasons: ['epic'] },
      ]);
      expect(hintsOf(reply, 'PROJ-11')?.map((h) => h.reasons)).toEqual([['epic']]);
      // PROJ-13 делит с остальными только метку источника — подсказки нет ни у неё, ни на неё.
      expect(hintsOf(reply, 'PROJ-13')).toBeUndefined();
      const id13 = byKey(reply, 'PROJ-13').entryId;
      expect(reply.cards.flatMap((c) => c.related ?? []).some((h) => h.entryId === id13)).toBe(
        false,
      );
      // Ни один опрос ничего не сложил: пять записей, ни у одной нет `merged`.
      expect(reply.entries.some((e) => e.merged !== undefined)).toBe(false);
      expect(byKey(reply, 'PROJ-10').state).toBe('inbox');
      // Запись в очереди подсказок не несёт (объединить можно только входящие).
      await one.move({ entryId: byKey(reply, 'PROJ-14').entryId, to: 'queue' });
      const after = await one.read();
      expect(hintsOf(after, 'PROJ-14')).toBeUndefined();
      expect(hintsOf(after, 'PROJ-10')?.map((h) => h.entryId)).not.toContain(
        byKey(after, 'PROJ-14').entryId,
      );
    });

    it('merge of 3 inbox entries → one entry carrying 3 sources, 2 gone, never recreated by the next poll; queued → 409; no human proof → refused', async () => {
      const one = await stand();
      await one.setBoard({ paused: true });
      await one.inbox.poll();
      const before = await one.read();
      const [id10, id11, id12, id13, id14] = [
        'PROJ-10',
        'PROJ-11',
        'PROJ-12',
        'PROJ-13',
        'PROJ-14',
      ].map((k) => byKey(before, k).entryId) as [string, string, string, string, string];
      const merge = { entryId: id10, to: 'merge', entryIds: [id11, id12] };

      // Без доказательства человека и токеном сессии модели — отказ суда, доска та же.
      const bare = await one.move(merge, { proof: false });
      expect(bare.status).toBe(403);
      const forged = await one.move(merge, { token: TOKENS.session });
      expect([forged.status, forged.body.code]).toEqual([403, 'forged-authority']);
      expect((await one.read()).entries).toHaveLength(5);

      // Запись в очереди не объединяется — ни целью, ни сложенной (409 со списком разрешённых).
      await one.move({ entryId: id14, to: 'queue' });
      const queuedTarget = await one.move({ entryId: id14, to: 'merge', entryIds: [id13] });
      expect([queuedTarget.status, queuedTarget.body.code]).toEqual([409, 'move-not-allowed']);
      const queuedFolded = await one.move({ entryId: id10, to: 'merge', entryIds: [id14] });
      expect([queuedFolded.status, queuedFolded.body.code]).toEqual([409, 'move-not-allowed']);
      expect(String(queuedFolded.body.reason)).toContain('only inbox entries merge');
      expect((await one.read()).entries).toHaveLength(5);

      const done = await one.move(merge);
      expect(done.status).toBe(200);
      const merged = await one.read();
      expect(merged.entries.map((e) => e.source.key).sort()).toEqual([
        'PROJ-10',
        'PROJ-13',
        'PROJ-14',
      ]);
      const kept = byKey(merged, 'PROJ-10');
      expect(kept.entryId).toBe(id10);
      expect([kept.source, ...(kept.merged ?? [])].map((s) => s.key)).toEqual([
        'PROJ-10',
        'PROJ-11',
        'PROJ-12',
      ]);
      // Одна задача по всем трём тикетам: снимки всех в `sources` запуска, одиночного `source` нет.
      expect(kept.launch.kind).toBe('fields');
      const fields = kept.launch.kind === 'fields' ? kept.launch.fields : {};
      expect(fields.source).toBeUndefined();
      expect((fields.sources as { key: string }[]).map((s) => s.key)).toEqual([
        'PROJ-10',
        'PROJ-11',
        'PROJ-12',
      ]);

      // Следующий опрос: сложенные тикеты не заводятся заново, выжившая запись — свой снимок.
      await one.inbox.poll();
      const polled = await one.read();
      expect(polled.entries.map((e) => e.source.key).sort()).toEqual([
        'PROJ-10',
        'PROJ-13',
        'PROJ-14',
      ]);
      const still = byKey(polled, 'PROJ-10');
      expect(still.source.title).toBe(titleOf('PROJ-10'));
      expect(still.reason).toBeUndefined();
      expect((still.merged ?? []).map((s) => s.key)).toEqual(['PROJ-11', 'PROJ-12']);

      // Отклонённая запись тоже не возвращается следующим опросом.
      await one.move({ entryId: id13, to: 'rejected' });
      await one.inbox.poll();
      const final = await one.read();
      expect(final.entries).toHaveLength(3);
      expect(byKey(final, 'PROJ-13').state).toBe('rejected');

      // Объединённая запись стартует одной задачей настоящей оценкой (три снимка — одна задача).
      await one.setBoard({ paused: false });
      await one.move({ entryId: id10, to: 'work' });
      await one.settle();
      const started = byKey(await one.read(), 'PROJ-10');
      expect(started.reason).toBeUndefined();
      expect(started.state).toBe('started');
      expect(started.taskId).toEqual(expect.any(String));
    });
  },
);
