import type { AdapterRegistry } from '../../adapters/index.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { ConductorHooks, RunEconomy } from '../../conductor/run/run.types.ts';
import type { LearnedTable } from '../../economy/learned/index.ts';
import type { PublisherCommandPort } from '../../conductor/commands/commands.types.ts';
import type { SplitEnv } from '../../conductor/estimate/index.ts';
import type { TaskEnvBook } from '../../conductor/task-env/index.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { Prepared, SessionRoad } from '../session-road.ts';
import type { VerifierWiring } from '../verifier-wiring/index.ts';
import type { ReviewLinkWiring } from '../review-link-wiring/index.ts';

/**
 * Что загрузка даёт дирижёру этапа 4: всё уже собранное `boot.ts` — одна обвязка проверок, одна
 * дорога сессии, один реестр задач. Зона берёт отсюда нужное и не собирает своё второе.
 */
export interface ConductorWiringDeps {
  registry: TaskRegistry;
  layout: CoreHomeLayout;
  verifier: VerifierWiring;
  road: SessionRoad;
  note: (event: string, data: Record<string, unknown>) => void;
  /** Те же реестры, что у дороги сессии: пробы дорог и разрешённые тройки — над тем, чем пойдёт сессия. */
  adapters?: AdapterRegistry;
  routes?: RouteRegistry;
  /**
   * Исполнитель задач (зона B): по умолчанию включён — каждую запущенную задачу ведёт `runTask`.
   * `false` — только крючки (сквозной прогон ведёт задачу сам, второй исполнитель ему помешал бы).
   */
  loop?: LoopOptions | false;
  /** Экономика исполнителя (этап 5, `bootEconomy`): одна на ядро, каждый `runTask` берёт её. */
  economy?: RunEconomy;
  /** Выученное по прошлым задачам — то же чтение, что у бюджета токенов исполнителя. */
  history?: () => Promise<LearnedTable | null>;
  /** Замер базы нового сеанса (G9, `baseAtStart`): исполнитель зовёт его после запуска. */
  measureBase?: (task: LiveTask, prepared: Prepared) => boolean;
  /** Книга токенов моста панели (вопрос «ask», этап 10 F2): конец задачи снимает её токен. */
  askBridges?: { drop(taskId: string): void };
  /**
   * Книга окружения задачи (этап 10, F6): оценка кладёт значения, исполнитель берёт их в пин
   * сеанса, конец задачи снимает. Нет — задача с `session.env` получает отказ дороги по имени.
   */
  taskEnv?: TaskEnvBook;
  /**
   * Каталог панели, решённый загрузкой (`panel.appData`), — откуда форж у ревью по ссылке,
   * публикатора и стража. Нет или `null` — без панели: проводки каталог сами не ищут.
   */
  panelAppData?: string | null;
}

/** Настройки исполнителя продукта (`conductor-wiring/loops.ts`). */
export interface LoopOptions {
  /** Пин окружения CLI; по умолчанию — окружение процесса ядра (`processPin`). */
  pin?: () => Record<string, string>;
  /** Каталоги PATH сессии перед путём оболочки входа. */
  pathPrefix?: readonly string[];
  /** Шаг обхода живых задач (мс); запуск задачи будит обход и без него. */
  sweepMs?: number;
  upkeepEveryMs?: number;
}

/** Крючки одной зоны; зона правит только свой файл `conductor-wiring/<zone>.ts`. */
export type ZoneHooks = (deps: ConductorWiringDeps) => ConductorHooks;

export interface ConductorHandle {
  /** Крючки зон в постоянном порядке (`ZONE_ORDER`) — исполнитель зовёт их по очереди. */
  hooks: readonly ConductorHooks[];
  /**
   * Среда деления — тот же объект, что держат крючки зоны D (`splitEnvFor` по этим `deps`).
   * Загрузка отдаёт её API (`/v1/estimate`) и командам через порт среды команды.
   */
  split: SplitEnv;
  /** Порт публикатора для команд `publish-now` и `clean-remote` — та же проводка, что у крючков. */
  publisher: PublisherCommandPort;
  /** Ревью MR по ссылке (этап 10, F8): `open` для `POST /v1/review-link` — та же проводка, что у крючков. */
  reviewLink: ReviewLinkWiring;
  /**
   * Запустить исполнителя задач — после записи ядра в `procs.json`: мост MCP сессии ищет ядро
   * по нему. Без `adapters` или при `loop: false` — ничего.
   */
  start(): void;
  /** Задачи, которые сейчас ведёт исполнитель. */
  running(): string[];
  stop(): Promise<void>;
}
