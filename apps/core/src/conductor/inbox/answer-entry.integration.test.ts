import { afterEach, describe, expect, it } from 'vitest';
import type { BoardEntry } from '@agentdeck/contracts/core/board';
import type { AllocatorWiring } from '../../bootstrap/allocator-wiring/index.ts';
import { createBoardWiring, type BoardWiring } from '../../bootstrap/board-wiring.ts';
import { createConfigPort } from '../../bootstrap/core-config/port.ts';
import type { BootEconomy } from '../../bootstrap/economy-wiring/boot-economy.ts';
import {
  closeWorlds,
  world,
  type World,
} from '../../bootstrap/forge-wiring/__fixtures__/answer-world.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../../bootstrap/guard-wiring/__fixtures__/guard-stand.ts';
import { WindowBook } from '../../economy/window/book.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createBoardStore } from '../board/store.ts';
import { ANSWER_REVIEWERS_PRESET } from '../estimate/estimate.ts';

/**
 * Запись входящих «мой MR с открытыми нитями» (этап 12, I3, P164) стартует дорогой ответов
 * ревьюерам (`openAnswerTaskFromMr`), а не общей оценкой и не ревью по ссылке: настоящий
 * основной репозиторий с удалённым — голым «сервером», заглушка форжа на loopback, настоящий реестр
 * и настоящая оценка (`answer-world`), настоящая проводка доски и её запускатель.
 */

const boards: BoardWiring[] = [];
afterEach(async () => {
  for (const b of boards.splice(0)) await b.stop();
  await closeWorlds();
});

async function ownMrWithThread(w: World): Promise<string> {
  const branch = `hand/${newId().slice(-8)}`;
  w.st.g(w.st.main, 'checkout', '-q', '-b', branch, 'origin/main');
  w.st.g(w.st.main, 'commit', '-q', '--allow-empty', '-m', 'hand-made change');
  w.st.g(w.st.main, 'push', '-q', 'origin', branch);
  w.st.g(w.st.main, 'checkout', '-q', '-');
  const opened = w.stub.act('publisher', {
    type: 'mr-open',
    sourceBranch: branch,
    targetBranch: 'main',
    title: 'Hand-made',
  }) as { iid: number };
  w.stub.act('reviewer', { type: 'note', mrIid: opened.iid, body: 'why this way?' });
  const mr = await w.port.mr(opened.iid);
  if (!('value' in mr)) throw new Error(JSON.stringify(mr));
  return mr.value.url;
}

/** Запись очереди с ходом человека — как после «в очередь» на доске. */
function queueOwnMr(w: World, mrUrl: string): string {
  const entryId = newId();
  createBoardStore({ root: w.layout.root }).update(newId(), Date.now(), (file) => {
    file.entries.push({
      entryId,
      state: 'queued',
      rank: 0,
      stop: 'mr',
      preset: ANSWER_REVIEWERS_PRESET,
      source: { kind: 'forge', system: 'gl', key: 'acme/app!1', url: mrUrl, title: 'Hand-made' },
      launch: { kind: 'link', mrUrl, repo: w.st.main },
      proof: { kind: 'human', cmdId: newId(), at: Date.now() },
      createdAt: Date.now(),
    });
    return { ok: true };
  });
  return entryId;
}

function boardOf(w: World, answer: boolean): BoardWiring {
  const config = createConfigPort({ layout: w.layout, note: () => undefined });
  const b = createBoardWiring({
    registry: w.registry,
    layout: w.layout,
    note: () => undefined,
    split: () => w.env,
    reviewLink: () => undefined,
    config: config.port,
    economy: { ladders: {} } as unknown as BootEconomy,
    windows: new WindowBook(),
    allocator: {} as AllocatorWiring,
    now: Date.now,
    git: w.git,
    ...(answer ? { answerForgeFor: () => w.port } : {}),
  });
  boards.push(b);
  return b;
}

async function settled(b: BoardWiring, w: World, entryId: string): Promise<BoardEntry> {
  b.start();
  await b.idle();
  await b.idle();
  return createBoardStore({ root: w.layout.root })
    .read()
    .entries.find((e) => e.entryId === entryId)!;
}

describe(
  'own MR from the inbox starts by the answer road (P164)',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    it('queued own-MR entry → an answer-reviewers task on the MR branch with the board entry and its threads', async () => {
      const w = await world();
      const mrUrl = await ownMrWithThread(w);
      const entryId = queueOwnMr(w, mrUrl);
      const entry = await settled(boardOf(w, true), w, entryId);
      expect(entry.state).toBe('started');
      const task = w.registry.live(entry.taskId!)!;
      expect(task.state.created!.scenario.id).toBe('answer-reviewers');
      expect(task.state.created!.launchPolicy).toBe('auto');
      expect(task.state.created!.boardEntry).toMatchObject({
        entryId,
        source: 'forge',
        proof: { kind: 'human' },
      });
      const [, zero] = Object.entries(task.state.units)[0]!;
      expect(zero.branch).toMatch(/^hand\//);
    });

    it('without the panel forge wired the entry returns to inbox with the reason, no task', async () => {
      const w = await world();
      const mrUrl = await ownMrWithThread(w);
      const before = w.registry.liveTasks().length;
      const entryId = queueOwnMr(w, mrUrl);
      const entry = await settled(boardOf(w, false), w, entryId);
      expect(entry.state).toBe('inbox');
      expect(entry.reason).toBe('answering reviewers from the board is not wired in this core');
      expect(w.registry.liveTasks().length).toBe(before);
    });
  },
);
