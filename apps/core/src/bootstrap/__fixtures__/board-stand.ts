import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BoardEntriesReply,
  BoardEntryDraft,
  BoardMoveReply,
  BoardReply,
} from '@agentdeck/contracts/core/board';
import { BOARD_DEFAULTS, type BoardSection } from '@agentdeck/contracts/core/config';
import { startStand, TOKENS, type Stand } from '../../api/__fixtures__/api-harness.ts';
import { createBoardWiring, type BoardWiring } from '../board-wiring.ts';
import type { AllocatorWiring } from '../allocator-wiring/index.ts';
import { createConfigPort, type CoreConfigWiring } from '../core-config/port.ts';
import type { BootEconomy } from '../economy-wiring/boot-economy.ts';
import type { ReviewLinkWiring } from '../review-link-wiring/index.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { gitRepo, testEnv, type TestEnv } from '../../conductor/split/__fixtures__/split-stand.ts';

/**
 * Стенд доски: настоящий API ядра (Fastify, суд полномочий, число страницы), настоящая проводка
 * доски (`createBoardWiring` — хранилище, вид, запускатель), настоящая настройка ядра (запись
 * раздела `board` через порт, как `POST /v1/config`), настоящий git-репозиторий и настоящая оценка.
 * Подменены только ответы проб дорог (`testEnv`) — внешние CLI и сеть.
 */

export interface BoardStand {
  s: Stand;
  root: string;
  repo: string;
  env: TestEnv;
  wiring: BoardWiring;
  config: CoreConfigWiring;
  /** Запись раздела `board` через порт настройки; ответ — `cmdId` записи в истории настройки. */
  setBoard(section: Partial<BoardSection>): Promise<string>;
  /** POST с честным доказательством человека (число страницы); `proof: false` — без него. */
  post<T>(
    path: string,
    body: Record<string, unknown>,
    opts?: { proof?: boolean; token?: string },
  ): Promise<{ status: number; body: T & { code?: string } }>;
  board(): Promise<BoardReply>;
  entries(
    to: 'inbox' | 'queue',
    drafts: BoardEntryDraft[],
    cmdId?: string,
  ): Promise<{ status: number; body: BoardEntriesReply & { code?: string } }>;
  move(
    m: Record<string, unknown>,
  ): Promise<{ status: number; body: BoardMoveReply & { code?: string; allowed?: string[] } }>;
  /** Дождаться покоя запускателя (такт и его повторы). */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export function fieldsDraft(
  repo: string,
  title: string,
  over: Partial<BoardEntryDraft> = {},
): BoardEntryDraft {
  return {
    preset: 'feature',
    source: { kind: 'manual', title },
    launch: {
      kind: 'fields',
      fields: { title, request: `Do ${title}.`, repos: [{ path: repo, baseRef: null }] },
    },
    ...over,
  };
}

export async function startBoardStand(
  opts: {
    now?: () => number;
    reviewLink?: () => ReviewLinkWiring | undefined;
    noSplit?: boolean;
    /** До сборки проводки (как файлы дома до загрузки ядра): дом ядра стенда и репозиторий. */
    seed?: (seed: {
      s: Stand;
      repo: string;
      setBoard: BoardStand['setBoard'];
    }) => void | Promise<void>;
  } = {},
): Promise<BoardStand> {
  const root = mkdtempSync(join(tmpdir(), 'core-board-'));
  // API собирается раньше проводки (как в загрузке): порт доски читается из ячейки при запросе.
  const cell: { wiring?: BoardWiring } = {};
  const s = await startStand(undefined, { board: () => cell.wiring?.port() });
  const repo = gitRepo(root, 'app');
  const config = createConfigPort({ layout: s.layout, note: () => undefined });
  const setBoard: BoardStand['setBoard'] = async (section) => {
    const view = config.port.view();
    if (!('value' in view)) throw new Error(view.unknown);
    const doc = {
      ...view.value.doc,
      board: { ...BOARD_DEFAULTS, ...view.value.doc.board, ...section },
    };
    const cmdId = newId();
    const got = await config.port.set(
      { cmdId, doc, baseDigest: view.value.digest, proof: {} },
      'nonce+peer',
    );
    if (got.status !== 200) throw new Error(`config write ${got.status}`);
    return cmdId;
  };
  await opts.seed?.({ s, repo, setBoard });
  const env = testEnv(join(root, 'scenarios'));
  if (!opts.noSplit) s.setSplit(env);
  const now = opts.now ?? Date.now;
  const w = createBoardWiring({
    registry: s.registry,
    layout: s.layout,
    note: () => undefined,
    split: () => (opts.noSplit ? undefined : env),
    reviewLink: opts.reviewLink ?? (() => undefined),
    config: config.port,
    // Запускатель читает из экономики только лестницы моделей; места сеансов он не судит (P141).
    economy: { ladders: {} } as unknown as BootEconomy,
    windows: s.windows,
    allocator: {} as AllocatorWiring,
    now,
  });
  cell.wiring = w;
  w.start();
  const stand: BoardStand = {
    s,
    root,
    repo,
    env,
    wiring: w,
    config,
    setBoard,
    async post(path, body, o = {}) {
      const proof = o.proof === false ? {} : await s.nonce();
      const res = await fetch(`${s.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${o.token ?? TOKENS.core}`,
        },
        body: JSON.stringify({ ...body, proof }),
      });
      return { status: res.status, body: (await res.json()) as never };
    },
    async board() {
      const res = await s.get('/v1/board');
      if (res.status !== 200) throw new Error(`GET /v1/board ${res.status}: ${await res.text()}`);
      return (await res.json()) as BoardReply;
    },
    entries: (to, drafts, cmdId = newId()) =>
      stand.post('/v1/board/entries', { cmdId, to, entries: drafts }),
    move: (m) => stand.post('/v1/board/move', { cmdId: newId(), ...m }),
    async settle() {
      // Такт запускателя один за раз: ждать, пока он и его повторы не кончатся.
      await w.idle();
      await w.idle();
    },
    async close() {
      await w.stop();
      config.dispose();
      await s.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  return stand;
}
