import { BOARD_DEFAULTS } from '@agentdeck/contracts/core/config';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import type { ConfigPort } from '../api/config.types.ts';
import { createBoardPort } from '../conductor/board/board.ts';
import { boardConfigIssuesOf, boardSectionOf } from '../conductor/board/gates.ts';
import { createLauncher, startAnswerEntry } from '../conductor/board/launch.ts';
import { createMrStateSweep, type MrStateReader } from '../conductor/board/mr-state.ts';
import type { GitOptions } from '../platform/git/git.types.ts';
import { unitMrOf, withoutUserinfo } from './forge-wiring/watched.ts';
import { repoServerOf } from './publish-wiring/unit-view.ts';
import { createTaskReader } from '../conductor/board/read.ts';
import { routeVerdict } from '../conductor/board/route.ts';
import { startEntry } from '../conductor/board/start.ts';
import { createBoardStore } from '../conductor/board/store.ts';
import { findConfigCmd } from '../platform/core-config/write.ts';
import type { BoardCommandPort, BoardPort } from '../conductor/board/board.types.ts';
import type { SplitEnv } from '../conductor/estimate/index.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { WindowBook } from '../economy/window/index.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import type { AllocatorWiring } from './allocator-wiring/index.ts';
import type { Note } from './boot/boot.types.ts';
import type { BootEconomy } from './economy-wiring/boot-economy.ts';
import { inboxAutoQueueOf } from './inbox-wiring.ts';
import type { BoardEntry } from '@agentdeck/contracts/core/board';
import type { AnswerMrPort } from '../conductor/estimate/answer-from-mr.ts';
import { createMrReader } from './takeover-wiring.ts';
import type { ReviewLinkWiring } from './review-link-wiring/index.ts';

/**
 * Проводка доски задач (этап 12). Скелет S1: загрузка уже собирает её и передаёт порты API и
 * командам, но порты пусты — `/v1/board*` отвечают 501, команды — `board-unwired`. Тело (хранилище
 * записей, вид доски, запускатель, конец MR) даёт зона Z1; набор зависимостей — всё, что запускатель
 * судит при старте (P154): настройка, окна, места сеансов, среда деления дирижёра.
 */

export interface BoardWiringDeps {
  registry: TaskRegistry;
  layout: CoreHomeLayout;
  note: Note;
  /** Среда деления дирижёра (ячейка загрузки); нет — дирижёр не подключён, старт не идёт. */
  split: () => SplitEnv | undefined;
  /** Ревью по ссылке дирижёра — старт записи с `launch.kind === 'link'`. */
  reviewLink: () => ReviewLinkWiring | undefined;
  config: ConfigPort;
  economy: BootEconomy;
  windows: WindowBook;
  allocator: AllocatorWiring;
  now: () => number;
  /**
   * Форж адреса remote для обхода конца MR (B10b); загрузка подаёт `forgeOfPanel(panel.appData)`.
   * Нет — обход не идёт и назван: подставить «панель по умолчанию» значило бы читать хранилище
   * ключей человека из любого теста, собравшего доску.
   */
  forgeFor?: (url: string) => Pick<ForgePort, 'kind' | 'mr'>;
  git?: GitOptions;
  /**
   * Форж адреса remote для записи «ответить ревьюерам» (Z7, P164); `null` — у адреса нет API.
   * Нет поля — такая запись не стартует и называет причину (тот же довод, что у `forgeFor`).
   */
  answerForgeFor?: (url: string) => AnswerMrPort | null;
}

export interface BoardWiring {
  /** Доска для API; `undefined` — проводка не собрана (501). */
  port(): BoardPort | undefined;
  /** Запускатель для команд задачи; `undefined` — отказ `board-unwired`. */
  commands(): BoardCommandPort | undefined;
  /** После `conductor.start()`: таймер запускателя. */
  start(): void;
  /** Перед остановкой дирижёра, с ожиданием: идущий старт ещё может открыть задачу. */
  stop(): Promise<void>;
  /** Один такт запускателя до конца (с его повторами) — тестам и остановке: дождаться покоя. */
  idle(): Promise<void>;
}

/** Обход запускателя без поводов: окно сбросилось, сутки сменились, задача кончилась в другом ядре. */
export const BOARD_SWEEP_MS = 30_000;

/**
 * Чтение MR единицы для обхода конца MR — тем же разбором, что у опроса и доработки: репозиторий
 * и ссылка базы единицы (`unitMrOf`), сервер репозитория (раз на пару репозиторий+ссылка за обход),
 * форж его адреса без `user:password@`, `ForgePort.mr(iid)`.
 */
export function boardMrReader(
  registry: TaskRegistry,
  forgeFor: (url: string) => Pick<ForgePort, 'kind' | 'mr'>,
  git: GitOptions = {},
): MrStateReader {
  const servers = new Map<string, ReturnType<typeof repoServerOf>>();
  return async (target) => {
    const unit = unitMrOf(registry, target.taskId, target.state, target.unitId);
    if (!unit) return { unknown: `unit ${target.unitId}: no repository` };
    const key = `${unit.repo}\u0000${unit.ref}`;
    let server = servers.get(key);
    if (!server) servers.set(key, (server = repoServerOf(unit.repo, unit.ref, git)));
    const got = await server;
    if (!('value' in got)) return { unknown: `${unit.repo}: ${got.unknown}` };
    return forgeFor(withoutUserinfo(got.value.url)).mr(target.mrIid);
  };
}

/** Строки живой задачи, после которых место или «ждёт вас» могли смениться. */
function wakesBoard(kind: string): boolean {
  return (
    kind === 'task.transition' ||
    kind === 'task.ended' ||
    kind === 'task.takeover' ||
    kind === 'task.handback' ||
    kind.startsWith('human.') ||
    kind.startsWith('session.')
  );
}

export function createBoardWiring(deps: BoardWiringDeps): BoardWiring {
  const { registry, layout } = deps;
  const note = (message: string): void => deps.note('board', { message });
  const store = createBoardStore({ root: layout.root });
  const tasks = createTaskReader({ registry });
  const section = () => boardSectionOf(deps.config.view());
  const launcher = createLauncher({
    store,
    tasks,
    section,
    proof: {
      configCmdExists: (cmdId) => findConfigCmd(layout, cmdId) !== undefined,
      // Z7: запись настройки — человек и включила автоочередь именно источника записи.
      configCmd: (cmdId) => findConfigCmd(layout, cmdId),
      // Раздел `inbox` с автоочередью (Z7): суд по действующей настройке на каждой записи.
      autoQueueOf: (source) => inboxAutoQueueOf(deps.config.view(), source),
    },
    route: (entry) =>
      routeVerdict(entry, {
        split: deps.split,
        linkWired: () => deps.reviewLink() !== undefined,
        decide: (routeId, now) => deps.windows.decide(routeId, now),
        ladders: deps.economy.ladders,
        now: deps.now,
      }),
    start: (entry) =>
      startEntry(entry, {
        registry,
        layout,
        split: deps.split,
        openLink: async (body, env, extra) => {
          const link = deps.reviewLink();
          if (!link) return { status: 501, problems: ['review by link is not wired in this core'] };
          return link.open(body, env, extra);
        },
      }),
    // Z7 (P164): мой MR из входящих — дорогой ответов ревьюерам; без форжа панели — отказ с причиной.
    ...(deps.answerForgeFor
      ? {
          answerFromMr: (entry: BoardEntry) =>
            startAnswerEntry(entry, {
              registry,
              split: deps.split,
              reader: createMrReader(deps.git ?? {}, deps.answerForgeFor!),
            }),
        }
      : {}),
    now: deps.now,
    note,
  });
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const watched = new Map<string, () => void>();

  /** Подписаться на живые задачи (новые с прошлого раза) и посмотреть очередь. */
  const wake = (): void => {
    if (!started) return;
    const live = registry.liveTasks();
    const ids = new Set(live.map((t) => t.state.taskId));
    for (const [id, off] of watched)
      if (!ids.has(id)) {
        off();
        watched.delete(id);
      }
    for (const task of live) {
      const id = task.state.taskId;
      if (watched.has(id)) continue;
      watched.set(
        id,
        task.subscribe((line) => {
          if (wakesBoard(line.kind)) wake();
        }),
      );
    }
    void launcher.tick();
  };

  const port = createBoardPort({
    store,
    tasks,
    section: () => {
      const got = section();
      return 'value' in got ? got.value : BOARD_DEFAULTS;
    },
    // Негодный раздел `board` порт настройки принимает и служит умолчаниями — доска это называет.
    configIssues: () => boardConfigIssuesOf(deps.config.view()),
    now: deps.now,
    onWrite: wake,
  });
  const commands: BoardCommandPort = { tick: wake };

  // Конец MR у форжа (B10b): на такте таймера и раз при старте, не на каждой строке журнала —
  // каждое чтение платит запросом к форжу.
  const forgeFor = deps.forgeFor;
  const mrSweep = forgeFor
    ? createMrStateSweep({
        tasks,
        registry,
        reader: () => boardMrReader(registry, forgeFor, deps.git),
        now: deps.now,
        note,
      })
    : undefined;
  const sweepMr = (): void => {
    if (started && mrSweep) void mrSweep.sweep();
  };

  return {
    port: () => port,
    commands: () => commands,
    start() {
      if (started) return;
      started = true;
      timer = setInterval(() => {
        wake();
        sweepMr();
      }, BOARD_SWEEP_MS);
      timer.unref();
      wake();
      if (!mrSweep) note('mr-state sweep off: no forge wired');
      sweepMr();
    },
    idle: () => launcher.tick(),
    async stop() {
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      for (const off of watched.values()) off();
      watched.clear();
      await launcher.stop();
      await mrSweep?.idle();
    },
  };
}
